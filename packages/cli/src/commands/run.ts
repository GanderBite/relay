/**
 * relay run — executes a flow from start to finish.
 *
 * Flow:
 *   1. loadFlow(nameOrPath, cwd) — resolve the flow package.
 *   2. parseInputFromArgv(flow.input, argv) — validate CLI arguments.
 *   3. Authenticate via ClaudeProvider — surface billing mode before any tokens.
 *   4. renderStartBanner — shows flow, input, run id, bill row, estimate.
 *   5. ProgressDisplay.start(runId) — live TTY progress grid.
 *   6. runner.run(flow, input, { runDir, flowPath }) — execute all steps.
 *   7. ProgressDisplay.stop() — clear live area.
 *   8. renderSuccessBanner / renderFailureBanner — final result.
 *   9. process.exit(0) on success, exitCodeFor(err) on failure.
 *
 * Flags:
 *   --resume <runId>   delegates to the resume command
 *   --cost             print per-step cost table after success banner
 *   --fresh            placeholder for sprint-13 task_88 (stale-runDir purge)
 *   --api-key          opt in to ANTHROPIC_API_KEY billing
 */

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import {
  ClaudeProvider,
  Runner,
  type AuthState,
  type RunResult,
  type StepState,
} from '@relay/core';

import type { SuccessStepRow, FailureStepRow } from '../banner.js';
import { renderFailureBanner, renderStartBanner, renderSuccessBanner } from '../banner.js';
import { exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { parseInputFromArgv } from '../input-parser.js';
import { ProgressDisplay, type AuthInfo } from '../progress.js';
import { maybeSendRunEvent } from '../telemetry.js';

// ---------------------------------------------------------------------------
// Public command interface
// ---------------------------------------------------------------------------

export interface RunCommandOptions {
  apiKey?: boolean;
  cost?: boolean;
  resume?: string;
  fresh?: boolean;
}

/**
 * Entry point dispatched by the CLI for `relay run <flow> [input-args...]`.
 *
 * @param args  Argv slice after "run": [flowNameOrPath, ...inputArgs]
 * @param opts  Parsed option flags from the dispatcher
 */
export default async function runCommand(
  args: unknown[],
  opts: unknown,
): Promise<void> {
  const options = (opts ?? {}) as RunCommandOptions;

  // --resume delegates to the resume command immediately.
  // Dynamic import is resolved at runtime via a variable path so the TypeScript
  // compiler does not demand the module to exist at type-check time — the resume
  // command is authored in a later sprint. A runtime import error surfaces as a
  // clear "not available" message rather than a hard crash.
  if (options.resume !== undefined) {
    const resumeModulePath = new URL('./resume.js', import.meta.url).pathname;
    try {
      const mod = await import(resumeModulePath) as { default: (args: unknown[], opts: unknown) => Promise<void> };
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
    if (loadErr.code === 'FLOW_NOT_FOUND') {
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
  // Step 3 — authenticate to get billing state for the banner
  // ---------------------------------------------------------------------------
  const provider = new ClaudeProvider({ allowApiKey: options.apiKey });
  const authResult = await provider.authenticate();

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

  // Derive step count and ETA from flow metadata.
  const stepCount = flow.stepOrder.length;
  const flowMeta = flow as unknown as Record<string, unknown>;
  const etaMin =
    typeof flowMeta['etaMin'] === 'number'
      ? (flowMeta['etaMin'] as number)
      : stepCount * 2;

  // Build the AuthInfo shape for ProgressDisplay.
  const authInfo: AuthInfo = {
    label: authState.billingSource === 'subscription'
      ? 'subscription (max)'
      : authState.billingSource,
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
    if (arg === undefined) { i++; continue; }
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

  // --fresh: TODO(task_88/sprint-13) — purge stale runDir with same input-hash.

  progress.start(runId);

  // ---------------------------------------------------------------------------
  // Step 6 — build and run the runner
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

  const runner = new Runner({ runDir });
  if (options.apiKey === true) {
    runner.allowApiKey();
  }

  let result: RunResult;
  try {
    result = await runner.run(flow, input, {
      flowDir,
      flowPath,
    });
  } catch (caught) {
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
  // Step 7 — stop progress display
  // ---------------------------------------------------------------------------
  progress.stop();

  // ---------------------------------------------------------------------------
  // Step 8 — read per-step data and render the appropriate banner
  // ---------------------------------------------------------------------------

  if (result.status === 'succeeded') {
    const stepRows = await buildSuccessStepRows(result.runDir, flow.stepOrder);
    const outputPath = result.artifacts.length > 0
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
  } else {
    // failed or aborted
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
// completedAt) and per-step cost from metrics.json (StepMetrics.costUsd).
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

async function readStateSteps(
  runDir: string,
): Promise<Record<string, RawStepState>> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), 'utf8');
    const parsed = JSON.parse(raw) as { steps?: Record<string, RawStepState> };
    return parsed.steps ?? {};
  } catch {
    return {};
  }
}

async function readMetrics(runDir: string): Promise<Map<string, RawMetrics>> {
  const map = new Map<string, RawMetrics>();
  try {
    const raw = await readFile(join(runDir, 'metrics.json'), 'utf8');
    const entries = JSON.parse(raw) as RawMetrics[];
    for (const entry of entries) {
      if (typeof entry.stepId === 'string') {
        map.set(entry.stepId, entry);
      }
    }
  } catch {
    // metrics.json may not exist for very short runs — fall back to zeros.
  }
  return map;
}

function stepDurationMs(stepState: RawStepState): number {
  if (
    typeof stepState.startedAt === 'string' &&
    typeof stepState.completedAt === 'string'
  ) {
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

  return stepOrder.map((stepId): SuccessStepRow => {
    const stepState = stateSteps[stepId];
    const metric = metrics.get(stepId);
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;
    return { name: stepId, model, durationMs, costUsd };
  });
}

async function buildFailureStepRows(
  runDir: string,
  stepOrder: string[],
): Promise<FailureStepRow[]> {
  const stateSteps = await readStateSteps(runDir);
  const metrics = await readMetrics(runDir);

  return stepOrder.map((stepId): FailureStepRow => {
    const stepState = stateSteps[stepId];
    const metric = metrics.get(stepId);
    const status = stepState?.status;
    const durationMs = metric?.durationMs ?? (stepState ? stepDurationMs(stepState) : 0);
    const model = metric?.model ?? 'sonnet';
    const costUsd = metric?.costUsd ?? 0;

    if (status === 'succeeded') {
      return { name: stepId, status: 'succeeded', model, durationMs, costUsd };
    }
    if (status === 'failed') {
      const errorMsg = stepState?.errorMessage;
      return {
        name: stepId,
        status: 'failed',
        model,
        durationMs,
        costUsd,
        exitCode: 1,
        errorLines:
          errorMsg !== undefined
            ? [errorMsg.slice(0, 80), ''] as [string, string]
            : undefined,
      };
    }
    // pending / running / skipped / undefined — treat as skipped in the banner
    return { name: stepId, status: 'skipped', model, durationMs, costUsd };
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
    'step'.padEnd(NAME_W) +
    'model'.padEnd(MODEL_W) +
    'duration'.padEnd(DUR_W) +
    'cost';
  const divider = '─'.repeat(NAME_W + MODEL_W + DUR_W + COST_W);

  const dataLines = rows.map((r) => {
    const durSec = r.durationMs / 1000;
    const durStr = durSec < 10
      ? `${durSec.toFixed(1)}s`
      : `${Math.round(durSec)}s`;
    const costStr = `$${(Math.ceil(r.costUsd * 1000) / 1000).toFixed(3)}`;
    return (
      r.name.padEnd(NAME_W) +
      r.model.padEnd(MODEL_W) +
      durStr.padEnd(DUR_W) +
      costStr
    );
  });

  return [header, divider, ...dataLines].join('\n');
}
