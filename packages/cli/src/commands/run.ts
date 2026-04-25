/**
 * relay run — executes a race from start to finish.
 *
 * Race:
 *   1. loadFlow(nameOrPath, cwd) — resolve the race package.
 *   2. parseInputFromArgv(race.input, argv) — validate CLI arguments.
 *   3. Register providers, load settings, resolve provider, authenticate — surface billing mode.
 *   4. renderStartBanner — shows race, input, run id, bill row, estimate.
 *   5. ProgressDisplay.start(runId) — live TTY progress grid.
 *   6. orchestrator.run(race, input, { raceDir }) — execute all runners.
 *   7. ProgressDisplay.stop() — clear live area.
 *   8. renderSuccessBanner / renderFailureBanner — final result.
 *   9. process.exit(0) on success, exitCodeFor(err) on failure.
 *
 * Flags:
 *   --resume <runId>      delegates to the resume command
 *   --cost               print per-step cost table after success banner
 *   --fresh              always start a new run (default behavior — relay run never implicitly resumes)
 *   --provider <name>    override provider selection (flag > flow-settings > global-settings)
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  type AuthState,
  defaultRegistry,
  ERROR_CODES,
  loadFlowSettings,
  loadGlobalSettings,
  Orchestrator,
  type RunResult,
  registerDefaultProviders,
  resolveProvider,
  type StepState,
} from '@relay/core';
import { z } from 'zod';

import type { FailureStepRow, SuccessStepRow } from '../banner.js';
import { renderFailureBanner, renderStartBanner, renderSuccessBanner } from '../banner.js';
import { exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { parseInputFromArgv } from '../input-parser.js';
import { renderPausedBanner } from '../paused-banner.js';
import { type AuthInfo, ProgressDisplay } from '../progress.js';
import { maybeSendRunEvent } from '../telemetry.js';

// ---------------------------------------------------------------------------
// Public command interface
// ---------------------------------------------------------------------------

export interface RunCommandOptions {
  cost?: boolean;
  resume?: string;
  fresh?: boolean;
  /** Provider name from --provider flag. Takes precedence over all settings. */
  provider?: string;
  /**
   * Commander flips this to `false` when the user passes `--no-worktree`.
   * Undefined or true falls back to the Orchestrator default ('auto': create a
   * worktree when inside a git repo, silently skip otherwise). False disables
   * the feature entirely for this run.
   */
  worktree?: boolean;
}

/**
 * Entry point dispatched by the CLI for `relay run <flow> [input-args...]`.
 *
 * @param args  Argv slice after "run": [flowNameOrPath, ...inputArgs]
 * @param opts  Parsed option flags from the dispatcher
 */
export default async function runCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as RunCommandOptions;

  // --resume delegates to the resume command immediately.
  // Dynamic import is resolved at runtime via a variable path so the TypeScript
  // compiler does not demand the module to exist at type-check time — the resume
  // command is authored in a later sprint. A runtime import error surfaces as a
  // clear "not available" message rather than a hard crash.
  if (options.resume !== undefined) {
    const resumeModulePath = new URL('./resume.js', import.meta.url).pathname;
    try {
      const mod = (await import(resumeModulePath)) as {
        default: (args: unknown[], opts: unknown) => Promise<void>;
      };
      await mod.default([options.resume], opts);
    } catch (importErr: unknown) {
      const msg = importErr instanceof Error ? importErr.message : String(importErr);
      process.stderr.write(`relay resume is not available: ${msg}\n`);
      process.exit(1);
    }
    return;
  }

  const stringArgs = (args as unknown[]).map(String);
  const nameOrPath: string = stringArgs[0] ?? '';
  const inputArgv: string[] = stringArgs.slice(1);

  if (nameOrPath === '') {
    process.stderr.write(
      formatError(new Error('usage: relay run <flow> [input options...]')) + '\n',
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Step 1 — load the flow package
  // ---------------------------------------------------------------------------
  const loadResult = await loadFlow(nameOrPath, process.cwd());
  if (loadResult.isErr()) {
    const loadErr = loadResult.error;
    if (loadErr.code === ERROR_CODES.FLOW_NOT_FOUND) {
      process.stderr.write(formatError(loadErr) + '\n');
      process.exit(1);
    }
    // FLOW_INVALID
    process.stderr.write(formatError(loadErr) + '\n');
    process.exit(2);
  }

  const loaded = loadResult.value;
  const { flow, dir: flowDir } = loaded;

  // ---------------------------------------------------------------------------
  // Step 2 — parse input from remaining argv
  // ---------------------------------------------------------------------------
  const parseResult = parseInputFromArgv(flow.input, inputArgv);
  if (parseResult.isErr()) {
    process.stderr.write(formatError(parseResult.error) + '\n');
    process.exit(2);
  }

  const input = parseResult.value;

  // ---------------------------------------------------------------------------
  // Step 3 — resolve provider from settings, then authenticate
  // ---------------------------------------------------------------------------

  // Register both Claude providers idempotently so the resolver chain can
  // find whichever the user (or settings) selected.
  registerDefaultProviders();

  // Load settings in parallel; failures are non-fatal — treat as null.
  const [globalSettingsResult, flowSettingsResult] = await Promise.all([
    loadGlobalSettings(),
    loadFlowSettings(flowDir),
  ]);

  const globalSettings = globalSettingsResult.isOk() ? globalSettingsResult.value : null;
  const flowSettings = flowSettingsResult.isOk() ? flowSettingsResult.value : null;

  const resolveResult = resolveProvider({
    ...(options.provider !== undefined ? { flagProvider: options.provider } : {}),
    flowSettings: flowSettings ?? null,
    globalSettings: globalSettings ?? null,
    registry: defaultRegistry,
  });

  if (resolveResult.isErr()) {
    process.stderr.write(formatError(resolveResult.error) + '\n');
    process.exit(exitCodeFor(resolveResult.error));
  }

  const resolvedProvider = resolveResult.value;
  const authResult = await resolvedProvider.authenticate();

  if (authResult.isErr()) {
    process.stderr.write(formatError(authResult.error) + '\n');
    process.exit(exitCodeFor(authResult.error));
  }

  const authState: AuthState = authResult.value;

  // ---------------------------------------------------------------------------
  // Step 4 — pre-flight: generate run id and build paths
  // ---------------------------------------------------------------------------
  const runId = randomBytes(3).toString('hex');
  const runDir = join(process.cwd(), '.relay', 'runs', runId);
  const flowPath = join(flowDir, 'dist', 'flow.js');

  // Derive runner count and ETA from race metadata.
  const stepCount = flow.stepOrder.length;
  const flowMeta = flow as unknown as Record<string, unknown>;
  const etaMin =
    typeof flowMeta['etaMin'] === 'number' ? (flowMeta['etaMin'] as number) : stepCount * 2;

  // Build the AuthInfo shape for ProgressDisplay.
  const authInfo: AuthInfo = {
    label:
      authState.billingSource === 'subscription' ? 'subscription (max)' : authState.billingSource,
    estUsd: 0,
  };

  // ---------------------------------------------------------------------------
  // Step 4 continued — render and write the start banner
  // ---------------------------------------------------------------------------

  // Separate positional args from --flag args for the banner display.
  // Positionals (no leading --) → first one is inputPrimary.
  // Named flags (--key value or --key=value) → reshaped as "key=value" extras.
  const positionals: string[] = [];
  const namedExtras: string[] = [];

  let i = 0;
  while (i < inputArgv.length) {
    const arg = inputArgv[i];
    if (arg === undefined) {
      i++;
      continue;
    }
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eqIdx = body.indexOf('=');
      if (eqIdx !== -1) {
        // --key=value → "key=value"
        namedExtras.push(body);
        i++;
      } else {
        const next = inputArgv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          // --key value → "key=value"
          namedExtras.push(`${body}=${next}`);
          i += 2;
        } else {
          // boolean flag with no value → "key=true"
          namedExtras.push(`${body}=true`);
          i++;
        }
      }
    } else {
      positionals.push(arg);
      i++;
    }
  }

  const inputPrimary = positionals[0] ?? '.';
  const inputExtras = namedExtras;

  const startBanner = renderStartBanner({
    flowName: flow.name,
    flowVersion: flow.version,
    runId,
    startedAt: new Date().toISOString(),
    inputPrimary,
    inputExtras,
    auth: authState,
    stepCount,
    etaMin,
  });

  process.stdout.write(startBanner);

  // ---------------------------------------------------------------------------
  // Step 5 — start progress display
  // ---------------------------------------------------------------------------
  const progress = new ProgressDisplay(runDir, flow, authInfo);

  progress.start(runId);

  // ---------------------------------------------------------------------------
  // SIGINT handler — Ctrl-C paused UX (product spec §11.5)
  //
  // First ^C: flag the interruption. The Orchestrator registers its own SIGINT
  // listener and fires its AbortController, which causes orchestrator.run() to
  // resolve with status = 'aborted'. We detect that below and render the
  // paused banner instead of the failure banner.
  //
  // Second ^C within 2 s: hard exit 130 (SIGINT convention).
  // ---------------------------------------------------------------------------
  let wasInterrupted = false;
  let lastSigintMs = 0;

  const sigintHandler = (): void => {
    const now = Date.now();
    if (!wasInterrupted || now - lastSigintMs > 2000) {
      wasInterrupted = true;
      lastSigintMs = now;
      // The Orchestrator's own SIGINT handler fires simultaneously and aborts the run.
      // Nothing more to do here — orchestrator.run() will resolve with 'aborted'.
    } else {
      // Second ^C within 2 s — hard exit.
      process.exit(130);
    }
  };

  process.on('SIGINT', sigintHandler);

  // ---------------------------------------------------------------------------
  // Step 6 — build and run the orchestrator
  // ---------------------------------------------------------------------------

  // Resolve relay version for the telemetry event. Falls back to 'unknown'
  // when the package.json is not available (e.g. running from source).
  // Resolved here so it is available in both the catch block and success/failure paths.
  const _require = createRequire(import.meta.url);
  let relayVersion = 'unknown';
  try {
    const meta: unknown = _require('@relay/cli/package.json');
    if (
      meta !== null &&
      typeof meta === 'object' &&
      'version' in meta &&
      typeof (meta as Record<string, unknown>)['version'] === 'string'
    ) {
      relayVersion = (meta as Record<string, unknown>)['version'] as string;
    }
  } catch {
    // version stays 'unknown'
  }

  const startMs = Date.now();

  const orchestrator = new Orchestrator({ runDir });

  let result: RunResult;
  try {
    // --fresh: always start a new run (default behavior — relay run never implicitly resumes).
    // The Orchestrator generates a fresh runId on every invocation so this flag is currently a no-op;
    // it is forwarded for future stale-runDir purge behavior and so the banner's next: block is truthful.
    const runOpts: Parameters<typeof orchestrator.run>[2] & { fresh?: boolean } = {
      flowDir: flowDir,
      flowPath: flowPath,
    };
    if (options.provider !== undefined) {
      runOpts.flagProvider = options.provider;
    }
    if (options.fresh === true) {
      runOpts.fresh = true;
    }
    // Commander flips `--no-worktree` to `worktree: false`; every other value
    // (undefined, true) leaves the Orchestrator default of 'auto' in place so
    // a fresh checkout of the CLI picks up isolation automatically.
    if (options.worktree === false) {
      runOpts.worktree = false;
    }
    result = await orchestrator.run(flow, input, runOpts);
  } catch (caught) {
    process.removeListener('SIGINT', sigintHandler);
    progress.stop();
    maybeSendRunEvent({
      flowName: flow.name,
      flowVersion: flow.version,
      status: 'failure',
      durationMs: Date.now() - startMs,
      stepsCount: flow.stepOrder.length,
      totalCostUsd: 0,
      relayVersion,
      nodeVersion: process.version.replace(/^v/, ''),
      platform: process.platform,
    });
    process.stderr.write(formatError(caught) + '\n');
    process.exit(exitCodeFor(caught));
  }

  // ---------------------------------------------------------------------------
  // Step 7 — stop progress display, remove SIGINT handler
  // ---------------------------------------------------------------------------
  process.removeListener('SIGINT', sigintHandler);
  progress.stop();

  // ---------------------------------------------------------------------------
  // Step 8 — read per-step data and render the appropriate banner
  // ---------------------------------------------------------------------------

  if (result.status === 'succeeded') {
    const stepRows = await buildSuccessStepRows(result.runDir, flow.stepOrder);
    const outputPath =
      result.artifacts.length > 0
        ? (result.artifacts[0] ?? `./.relay/runs/${result.runId}`)
        : `./.relay/runs/${result.runId}`;

    const successBanner = renderSuccessBanner({
      flowName: flow.name,
      runId: result.runId,
      steps: stepRows,
      totalDurationMs: result.durationMs,
      totalCostUsd: result.cost.totalUsd,
      auth: authState,
      outputPath,
    });

    process.stdout.write(successBanner);

    // --cost: per-step cost table
    if (options.cost === true) {
      process.stdout.write(buildCostTable(stepRows) + '\n');
    }

    maybeSendRunEvent({
      flowName: flow.name,
      flowVersion: flow.version,
      status: 'success',
      durationMs: result.durationMs,
      stepsCount: flow.stepOrder.length,
      totalCostUsd: result.cost.totalUsd,
      relayVersion,
      nodeVersion: process.version.replace(/^v/, ''),
      platform: process.platform,
    });

    process.exit(0);
  } else if (result.status === 'aborted' && wasInterrupted) {
    // Ctrl-C paused — render paused banner, exit 130 (SIGINT convention).
    // This is not an error: state is saved, the run can be resumed.
    await renderPausedBanner(flow.name, result.runId, result.runDir, flow.stepOrder);

    maybeSendRunEvent({
      flowName: flow.name,
      flowVersion: flow.version,
      status: 'aborted',
      durationMs: result.durationMs,
      stepsCount: flow.stepOrder.length,
      totalCostUsd: result.cost.totalUsd,
      relayVersion,
      nodeVersion: process.version.replace(/^v/, ''),
      platform: process.platform,
    });

    process.exit(130);
  } else {
    // failed or aborted (non-interactive)
    const failureRows = await buildFailureStepRows(result.runDir, flow.stepOrder);
    const failureBanner = renderFailureBanner({
      flowName: flow.name,
      runId: result.runId,
      steps: failureRows,
      spentUsd: result.cost.totalUsd,
    });

    process.stdout.write(failureBanner);

    maybeSendRunEvent({
      flowName: flow.name,
      flowVersion: flow.version,
      status: result.status === 'aborted' ? 'aborted' : 'failure',
      durationMs: result.durationMs,
      stepsCount: flow.stepOrder.length,
      totalCostUsd: result.cost.totalUsd,
      relayVersion,
      nodeVersion: process.version.replace(/^v/, ''),
      platform: process.platform,
    });

    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Per-step data builders
//
// After the run, step timing comes from state.json (StepState.startedAt /
// completedAt) and per-runner cost from metrics.json (RunnerMetrics.costUsd).
// Both are read once here; missing data falls back to safe zero values.
// ---------------------------------------------------------------------------

interface RawStepState extends StepState {
  model?: string;
}

interface RawMetrics {
  stepId: string;
  durationMs?: number;
  costUsd?: number;
  model?: string;
}

const RawStepStateSchema = z.object({
  status: z.string(),
  attempt: z.number().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  error: z.string().optional(),
});

const RawStateJsonSchema = z.object({
  steps: z.record(z.string(), RawStepStateSchema).optional(),
});

const RawMetricsSchema = z.object({
  stepId: z.string(),
  durationMs: z.number().optional(),
  costUsd: z.number().optional(),
  model: z.string().optional(),
});

const RawMetricsArraySchema = z.array(RawMetricsSchema);

async function readStateSteps(runDir: string): Promise<Record<string, RawStepState>> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8');
    const result = RawStateJsonSchema.safeParse(JSON.parse(raw));
    return result.success
      ? ((result.data.steps ?? {}) as unknown as Record<string, RawStepState>)
      : {};
  } catch {
    return {};
  }
}

async function readMetrics(runDir: string): Promise<Map<string, RawMetrics>> {
  const map = new Map<string, RawMetrics>();
  try {
    const raw = await readFile(join(runDir, 'metrics.json'), 'utf8');
    const parseResult = RawMetricsArraySchema.safeParse(JSON.parse(raw));
    const entries = parseResult.success ? parseResult.data : [];
    for (const entry of entries) {
      if (typeof entry.stepId === 'string') {
        map.set(entry.stepId, entry as unknown as RawMetrics);
      }
    }
  } catch {
    // metrics.json may not exist for very short runs — fall back to zeros.
  }
  return map;
}

function stepDurationMs(stepState: RawStepState): number {
  if (typeof stepState.startedAt === 'string' && typeof stepState.completedAt === 'string') {
    const start = Date.parse(stepState.startedAt);
    const end = Date.parse(stepState.completedAt);
    if (Number.isFinite(start) && Number.isFinite(end)) return Math.max(0, end - start);
  }
  return 0;
}

async function buildSuccessStepRows(
  runDir: string,
  stepOrder: string[],
): Promise<SuccessStepRow[]> {
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  return stepOrder.map((runnerId): SuccessStepRow => {
    const stepState = stateSteps[runnerId];
    const metric = metrics.get(runnerId);
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;
    return { name: runnerId, model, durationMs, costUsd };
  });
}

async function buildFailureStepRows(
  runDir: string,
  stepOrder: string[],
): Promise<FailureStepRow[]> {
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  return stepOrder.map((runnerId): FailureStepRow => {
    const stepState = stateSteps[runnerId];
    const metric = metrics.get(runnerId);
    const status = stepState?.status;
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;

    if (status === 'succeeded') {
      return { name: runnerId, status: 'succeeded', model, durationMs, costUsd };
    }
    if (status === 'failed') {
      const errorMsg = stepState?.errorMessage;
      const errorLines: [string, string] | undefined =
        errorMsg !== undefined ? [errorMsg.slice(0, 80), ''] : undefined;
      return {
        name: runnerId,
        status: 'failed',
        model,
        durationMs,
        costUsd,
        exitCode: 1,
        ...(errorLines !== undefined ? { errorLines } : {}),
      };
    }
    // pending / running / skipped / undefined — treat as skipped in the banner
    return { name: runnerId, status: 'skipped', model, durationMs, costUsd };
  });
}

// ---------------------------------------------------------------------------
// --cost table
//
// Printed below the success banner when --cost is passed.
// Columns: step name, model, duration, cost USD.
// ---------------------------------------------------------------------------

function buildCostTable(rows: SuccessStepRow[]): string {
  const NAME_W = 20;
  const MODEL_W = 12;
  const DUR_W = 10;
  const COST_W = 10;

  const header =
    'step'.padEnd(NAME_W) + 'model'.padEnd(MODEL_W) + 'duration'.padEnd(DUR_W) + 'cost';
  const divider = '─'.repeat(NAME_W + MODEL_W + DUR_W + COST_W);

  const dataLines = rows.map((r) => {
    const durSec = r.durationMs / 1000;
    const durStr = durSec < 10 ? `${durSec.toFixed(1)}s` : `${Math.round(durSec)}s`;
    const costStr = `$${(Math.ceil(r.costUsd * 1000) / 1000).toFixed(3)}`;
    return r.name.padEnd(NAME_W) + r.model.padEnd(MODEL_W) + durStr.padEnd(DUR_W) + costStr;
  });

  return [header, divider, ...dataLines].join('\n');
}
