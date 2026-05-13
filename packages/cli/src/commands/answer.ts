/**
 * `relay answer <runId> [--json <jsonString>]` — collect answers for a paused
 * run and auto-resume it.
 *
 * 1. Load state.json; reject non-paused runs with exit 1.
 * 2. If awaitingInput has no questions, write empty answer handoff and resume.
 * 3. --json mode: parse AnswerMap, validate required fields.
 * 4. Interactive mode: prompt each question via readline.
 * 5. Write the answer handoff at <runDir>/handoffs/__ask_<stepId>__.json via
 *    atomicWriteJson (bypasses HandoffStore, which rejects __ prefixes).
 * 6. Transition the paused step back to pending via StateMachine.resumePausedStep.
 * 7. Call orchestrator.resume with ProgressDisplay; exit 0/75/1 on outcome.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  AnswerMap,
  AuthState,
  AwaitingInput,
  Question,
  RunState,
} from '@ganderbite/relay-core';
import {
  askAnswerHandoffPath,
  askIterationAnswerHandoffPath,
  atomicWriteJson,
  loadState,
  Orchestrator,
  registerDefaultProviders,
  StateMachine,
  StateNotFoundError,
} from '@ganderbite/relay-core';
import { renderFailureBanner, renderSuccessBanner } from '../banner.js';
import { SYMBOLS } from '../brand.js';
import { gray, red, yellow } from '../color.js';
import { EXIT_CODES, exitCodeFor, formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { authenticateProvider } from '../load-flow-and-auth.js';
import { renderPausedBanner } from '../paused-banner.js';
import { type AuthInfo, ProgressDisplay } from '../progress.js';
import { buildFailureStepRows, buildSuccessStepRows } from '../step-data.js';
import { askQuestion, collectMissingRequired, makeReadline } from './answer-prompt.js';

interface FlowRef {
  flowName: string;
  flowVersion: string;
  flowPath: string | null;
}

export interface AnswerCommandOptions {
  json?: string;
  verbose?: boolean;
}

export default async function answerCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as AnswerCommandOptions;

  // ---- (1) Parse runId ----
  const runId = typeof args[0] === 'string' ? args[0] : undefined;
  if (runId === undefined || runId.trim() === '') {
    // usage-error: formatError does not apply
    process.stderr.write(red(`  ${SYMBOLS.fail} relay answer requires a run id`) + '\n');
    process.stderr.write(gray('  relay runs') + '\n');
    process.exit(1);
  }

  const runDir = join(process.cwd(), '.relay', 'runs', runId);

  // ---- (2) Load state.json ----
  const stateResult = await loadState(runDir);
  if (stateResult.isErr()) {
    const e = stateResult.error;
    if (e instanceof StateNotFoundError) {
      // usage-error: formatError does not apply
      process.stderr.write(red(`  ${SYMBOLS.fail} no run found at ${runId}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    } else {
      // usage-error: formatError does not apply
      process.stderr.write(
        red(`  ${SYMBOLS.fail} could not read run state for ${runId}: ${e.message}`) + '\n',
      );
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    }
    process.exit(1);
  }

  const state: RunState = stateResult.value;

  // ---- (3) Guard: must be paused ----
  if (state.status !== 'paused') {
    process.stderr.write(yellow(`  ${SYMBOLS.warn} run ${runId} is not paused`) + '\n');
    if (state.status === 'running') {
      process.stderr.write(gray(`  the run is currently in progress`) + '\n');
    } else if (state.status === 'succeeded') {
      process.stderr.write(gray(`  the run has already completed`) + '\n');
    } else if (state.status === 'failed' || state.status === 'aborted') {
      process.stderr.write(gray(`  resume the run first: relay resume ${runId}`) + '\n');
    }
    process.exit(1);
  }

  // ---- (4) Load flow-ref.json ----
  let flowRef: FlowRef;
  try {
    const raw = await readFile(join(runDir, 'flow-ref.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      typeof (parsed as Record<string, unknown>)['flowName'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['flowVersion'] !== 'string'
    ) {
      throw new Error('flow-ref.json is malformed');
    }
    const p = parsed as Record<string, unknown>;
    flowRef = {
      flowName: p['flowName'] as string,
      flowVersion: p['flowVersion'] as string,
      flowPath: typeof p['flowPath'] === 'string' ? p['flowPath'] : null,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // usage-error: formatError does not apply
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load flow-ref.json for run ${runId}: ${msg}`) + '\n',
    );
    process.stderr.write(gray('  did you mean: relay runs') + '\n');
    process.exit(1);
  }

  if (flowRef.flowPath === null) {
    // usage-error: formatError does not apply
    process.stderr.write(red(`  ${SYMBOLS.fail} run has no recorded flow path`) + '\n');
    process.exit(1);
  }

  // ---- (5) Register providers and authenticate ----
  registerDefaultProviders();

  const authResult = await authenticateProvider({ flowDir: dirname(flowRef.flowPath) });
  if (authResult.isErr()) {
    process.stderr.write(formatError(authResult.error) + '\n');
    process.exit(exitCodeFor(authResult.error));
  }
  const { resolvedProvider, authState } = authResult.value;

  // ---- (6) Resolve the paused ask step ----
  const awaitingInput: AwaitingInput | undefined = state.awaitingInput;

  let pausedStepId: string | undefined = awaitingInput?.stepId;
  if (pausedStepId === undefined) {
    for (const [id, stepState] of Object.entries(state.steps)) {
      if (stepState.status === 'paused') {
        pausedStepId = id;
        break;
      }
    }
  }

  if (pausedStepId === undefined) {
    // usage-error: formatError does not apply
    process.stderr.write(
      red(`  ${SYMBOLS.fail} run ${runId} is paused but has no awaiting step`) + '\n',
    );
    process.stderr.write(gray('  relay runs') + '\n');
    process.exit(1);
  }

  const questions: Question[] = awaitingInput?.questions ?? [];

  // ---- (7) Collect answers ----
  let answers: AnswerMap;

  if (options.json !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.json);
    } catch {
      // usage-error: formatError does not apply
      process.stderr.write(red(`  ${SYMBOLS.fail} --json value is not valid JSON`) + '\n');
      process.exit(1);
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // usage-error: formatError does not apply
      process.stderr.write(red(`  ${SYMBOLS.fail} --json value must be a JSON object`) + '\n');
      process.exit(1);
    }
    answers = parsed as AnswerMap;
    const missing = collectMissingRequired(questions, answers);
    if (missing.length > 0) {
      // usage-error: formatError does not apply
      process.stderr.write(
        red(`  ${SYMBOLS.fail} missing answers for: ${missing.join(', ')}`) + '\n',
      );
      process.exit(1);
    }
  } else {
    answers = {};
    if (questions.length > 0) {
      const rl = makeReadline();
      try {
        for (const q of questions) {
          const val = await askQuestion(rl, q);
          answers[q.id] = val;
        }
      } finally {
        rl.close();
      }
    }
  }

  // ---- (8) Write the answer handoff ----
  // atomicWriteJson bypasses HandoffStore (rejects __ prefixes). Route to
  // iteration-scoped path when inside a loop body.
  let handoffPath: string;
  if (
    awaitingInput !== undefined &&
    awaitingInput.loopStepId !== undefined &&
    awaitingInput.loopIter !== undefined
  ) {
    const prefix = awaitingInput.loopStepId + '::';
    const bareBodyStepId = awaitingInput.stepId.startsWith(prefix)
      ? awaitingInput.stepId.slice(prefix.length)
      : awaitingInput.stepId;
    handoffPath = askIterationAnswerHandoffPath(
      runDir,
      awaitingInput.loopStepId,
      awaitingInput.loopIter,
      bareBodyStepId,
    );
  } else {
    handoffPath = askAnswerHandoffPath(runDir, pausedStepId);
  }
  const writeResult = await atomicWriteJson(handoffPath, answers);
  if (writeResult.isErr()) {
    // usage-error: formatError does not apply
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not write answer handoff: ${writeResult.error.message}`) + '\n',
    );
    process.exit(EXIT_CODES.io_error);
  }

  // ---- (9) Transition paused step back to pending ----
  const machine = new StateMachine(runDir, state.flowName, state.flowVersion, state.runId);
  machine.hydrate(state);

  const resumeResult = machine.resumePausedStep(pausedStepId);
  if (resumeResult.isErr()) {
    // usage-error: formatError does not apply
    process.stderr.write(
      red(
        `  ${SYMBOLS.fail} could not transition step ${pausedStepId} to pending: ${resumeResult.error.message}`,
      ) + '\n',
    );
    process.exit(1);
  }

  const saveResult = await machine.save();
  if (saveResult.isErr()) {
    // usage-error: formatError does not apply
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not persist run state: ${saveResult.error.message}`) + '\n',
    );
    process.exit(EXIT_CODES.io_error);
  }

  // ---- (10) Auto-resume with ProgressDisplay + banners ----
  // Load the flow module for ProgressDisplay and banner rendering.
  // If the load fails, fall back to a no-display path: the orchestrator still
  // runs and banners render with topoOrder = [].
  const flowLoadResult = await loadFlow(flowRef.flowPath, process.cwd());
  const flow = flowLoadResult.isOk() ? flowLoadResult.value.flow : null;
  if (flow === null) {
    process.stderr.write(
      yellow(
        `  ${SYMBOLS.warn} could not load flow module for display: continuing without progress`,
      ) + '\n',
    );
  }

  const orchestrator = new Orchestrator({ runDir });

  const authInfo: AuthInfo = {
    label: authState.billingSource === 'subscription' ? 'subscription (max)' : 'api account',
    estUsd: 0,
  };

  // Only construct ProgressDisplay when we have a valid flow module.
  const display =
    flow !== null ? new ProgressDisplay(runDir, flow, authInfo, options.verbose === true) : null;
  if (display !== null) display.start(runId);

  let wasInterrupted = false;
  let lastSigintMs = 0;
  const sigintHandler = (): void => {
    const now = Date.now();
    if (!wasInterrupted || now - lastSigintMs > 2000) {
      wasInterrupted = true;
      lastSigintMs = now;
    } else {
      process.exit(130);
    }
  };
  process.on('SIGINT', sigintHandler);

  const topoOrder = flow?.graph.topoOrder ?? [];

  let exitCode = 0;
  try {
    const preAuthedMap = new Map<string, AuthState>();
    preAuthedMap.set(resolvedProvider.name, authState);
    const resumeOpts: Parameters<typeof orchestrator.resume>[1] = {
      logToStdout: !process.stdout.isTTY,
    };
    resumeOpts.resolvedProviderName = resolvedProvider.name;
    if (options.verbose === true) resumeOpts.verbose = true;
    resumeOpts.preAuthedState = preAuthedMap;
    if (display !== null) {
      resumeOpts.onStepComplete = (stepId, stepResult) => {
        if ('kind' in stepResult && stepResult.kind === 'prompt') {
          display.updateRunnerMetrics(stepId, {
            tokensIn: stepResult.tokensIn,
            tokensOut: stepResult.tokensOut,
            costUsd: stepResult.costUsd,
            durationMs: stepResult.durationMs,
            model: stepResult.model,
          });
        }
      };
    }
    const result = await orchestrator.resume(runDir, resumeOpts);

    process.removeListener('SIGINT', sigintHandler);
    // await so the events-file watcher fully drains before the banner prints
    if (display !== null) await display.stop();

    if (result.status === 'succeeded') {
      const stepRows = await buildSuccessStepRows(runDir, [...topoOrder]);
      const outputPath = result.artifacts[0] ?? `.relay/runs/${runId}`;
      process.stdout.write(
        renderSuccessBanner({
          flowName: flowRef.flowName,
          runId,
          steps: stepRows,
          totalDurationMs: result.durationMs,
          totalCostUsd: result.cost.totalUsd,
          auth: authState,
          outputPath,
        }),
      );
    } else if (result.status === 'paused') {
      await renderPausedBanner(
        flowRef.flowName,
        runId,
        runDir,
        [...topoOrder],
        result.pausedStepId !== undefined ? { stepId: result.pausedStepId } : undefined,
      );
      process.exit(EXIT_CODES.paused);
    } else if (result.status === 'aborted' && wasInterrupted) {
      await renderPausedBanner(flowRef.flowName, runId, runDir, topoOrder);
      process.exit(130);
    } else {
      const failureSteps = await buildFailureStepRows(runDir, [...topoOrder]);
      process.stdout.write(
        renderFailureBanner({
          flowName: flowRef.flowName,
          runId,
          steps: failureSteps,
          spentUsd: result.cost.totalUsd,
        }),
      );
      exitCode = 1;
    }
  } catch (caught) {
    process.removeListener('SIGINT', sigintHandler);
    // await so the events-file watcher fully drains before the banner prints
    if (display !== null) await display.stop();
    process.stderr.write(formatError(caught) + '\n');
    exitCode = exitCodeFor(caught);
  }

  if (exitCode !== 0) process.exit(exitCode);
}
