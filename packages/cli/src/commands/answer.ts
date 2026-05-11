/**
 * `relay answer <runId> [--json <jsonString>]` — collect answers for a paused
 * run and auto-resume it.
 *
 * Flow:
 *   1. Load state.json; reject non-paused runs with exit 1.
 *   2. If awaitingInput has no questions, write empty answer handoff and resume.
 *   3. --json mode: parse the JSON string as AnswerMap, validate required fields.
 *   4. Interactive mode: prompt each question via readline.
 *   5. Write the answer handoff at <runDir>/handoffs/__ask_<stepId>__.json
 *      directly via atomicWriteJson (HandoffStore validates ids against a
 *      pattern that rejects leading underscores; the ask key __ask_<stepId>__
 *      uses double-underscore prefix by convention so we bypass the store).
 *   6. Transition the paused step back to pending via StateMachine.resumePausedStep.
 *   7. Call orchestrator.resume; exit 0 on success, 75 if paused again.
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AnswerMap,
  AuthState,
  AwaitingInput,
  Question,
  RunState,
} from '@ganderbite/relay-core';
import {
  askAnswerHandoffKey,
  askAnswerHandoffPath,
  askIterationAnswerHandoffPath,
  atomicWriteJson,
  loadState,
  Orchestrator,
  registerDefaultProviders,
  StateMachine,
  StateNotFoundError,
} from '@ganderbite/relay-core';
import { SYMBOLS } from '../brand.js';
import { gray, red, yellow } from '../color.js';
import { EXIT_CODES, exitCodeFor, formatError } from '../exit-codes.js';
import { authenticateProvider } from '../load-flow-and-auth.js';

// ---------------------------------------------------------------------------
// FlowRef shape — mirrors core/orchestrator/resume.ts FlowRef
// ---------------------------------------------------------------------------

interface FlowRef {
  flowName: string;
  flowVersion: string;
  flowPath: string | null;
}

// ---------------------------------------------------------------------------
// Interactive prompting helpers
// ---------------------------------------------------------------------------

function makeReadline(): ReturnType<typeof createInterface> {
  return createInterface({ input: process.stdin, output: process.stdout });
}

async function promptText(rl: ReturnType<typeof createInterface>, label: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(`${SYMBOLS.dot} ${label}: `, (answer) => resolve(answer));
  });
}

async function askQuestion(rl: ReturnType<typeof createInterface>, q: Question): Promise<unknown> {
  switch (q.kind) {
    case 'text':
    case 'multiline': {
      const raw = await promptText(rl, q.label);
      return raw;
    }

    case 'number': {
      let val: number;
      for (;;) {
        const raw = await promptText(rl, q.label);
        const n = Number(raw.trim());
        if (!Number.isFinite(n)) {
          process.stdout.write(gray(`  enter a number\n`));
          continue;
        }
        if (q.kind === 'number' && q.min !== undefined && n < q.min) {
          process.stdout.write(gray(`  minimum is ${q.min}\n`));
          continue;
        }
        if (q.kind === 'number' && q.max !== undefined && n > q.max) {
          process.stdout.write(gray(`  maximum is ${q.max}\n`));
          continue;
        }
        val = n;
        break;
      }
      return val;
    }

    case 'confirm': {
      const defaultStr = q.default === true ? 'Y/n' : q.default === false ? 'y/N' : 'y/n';
      const raw = await promptText(rl, `${q.label} (${defaultStr})`);
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === '') {
        return q.default ?? false;
      }
      return trimmed === 'y' || trimmed === 'yes';
    }

    case 'select': {
      process.stdout.write(`${SYMBOLS.dot} ${q.label}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`    ${i + 1}. ${opt}\n`);
      });
      for (;;) {
        const raw = await promptText(rl, `select 1-${q.options.length}`);
        const n = parseInt(raw.trim(), 10);
        if (Number.isNaN(n) || n < 1 || n > q.options.length) {
          process.stdout.write(gray(`  enter a number between 1 and ${q.options.length}\n`));
          continue;
        }
        return q.options[n - 1];
      }
    }

    case 'multiselect': {
      process.stdout.write(`${SYMBOLS.dot} ${q.label}\n`);
      q.options.forEach((opt, i) => {
        process.stdout.write(`    ${i + 1}. ${opt}\n`);
      });
      const minDesc = q.min !== undefined ? `, min ${q.min}` : '';
      const maxDesc = q.max !== undefined ? `, max ${q.max}` : '';
      for (;;) {
        const raw = await promptText(rl, `select (comma-separated indices${minDesc}${maxDesc})`);
        const parts = raw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
        const indices = parts.map((s) => parseInt(s, 10));
        if (indices.some((n) => Number.isNaN(n) || n < 1 || n > q.options.length)) {
          process.stdout.write(
            gray(`  enter comma-separated numbers between 1 and ${q.options.length}\n`),
          );
          continue;
        }
        if (q.min !== undefined && indices.length < q.min) {
          process.stdout.write(gray(`  select at least ${q.min}\n`));
          continue;
        }
        if (q.max !== undefined && indices.length > q.max) {
          process.stdout.write(gray(`  select at most ${q.max}\n`));
          continue;
        }
        return indices.map((n) => q.options[n - 1]);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function collectMissingRequired(questions: Question[], answers: AnswerMap): string[] {
  const missing: string[] = [];
  for (const q of questions) {
    if (q.kind === 'confirm' || q.kind === 'multiselect') continue;
    const required = 'required' in q ? q.required : undefined;
    if (required !== true) continue;
    const val = answers[q.id];
    if (val === undefined || val === null || val === '') {
      missing.push(q.id);
    }
  }
  return missing;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

export interface AnswerCommandOptions {
  json?: string;
}

/**
 * Entry point for `relay answer <runId> [--json <jsonString>]`.
 */
export default async function answerCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as AnswerCommandOptions;

  // ---- (1) Parse runId ----
  const runId = typeof args[0] === 'string' ? args[0] : undefined;
  if (runId === undefined || runId.trim() === '') {
    // usage-error: formatError does not apply — missing argument is not a PipelineError type
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
      // usage-error: formatError does not apply — StateNotFoundError is not a PipelineError type
      process.stderr.write(red(`  ${SYMBOLS.fail} no run found at ${runId}`) + '\n');
      process.stderr.write(gray('  did you mean: relay runs') + '\n');
    } else {
      // usage-error: formatError does not apply — generic I/O error reading state, no PipelineError type
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
  // The orchestrator.resume() call below executes the run through the same
  // path as `relay resume`: it must have a provider registered and an auth
  // state preflighted, otherwise provider resolution inside executeRun throws
  // "unknown provider: claude-cli". Mirror resume.ts: load flow-ref to find
  // the flow directory (settings live next to the flow), then run the auth
  // guard before constructing the Orchestrator.
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
    // usage-error: formatError does not apply — malformed or missing flow-ref.json, not a PipelineError type
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not load flow-ref.json for run ${runId}: ${msg}`) + '\n',
    );
    process.stderr.write(gray('  did you mean: relay runs') + '\n');
    process.exit(1);
  }

  if (flowRef.flowPath === null) {
    // usage-error: formatError does not apply — missing flowPath in persisted ref, not a PipelineError type
    process.stderr.write(red(`  ${SYMBOLS.fail} run has no recorded flow path`) + '\n');
    process.exit(1);
  }

  // ---- (5) Register providers and authenticate ----
  // registerDefaultProviders() populates the defaultRegistry that executeRun
  // reads from; authenticateProvider() runs the §8.1 billing-safety guard
  // before any tokens can be spent. We forward the resulting AuthState into
  // orchestrator.resume() via preAuthedState so the orchestrator does not
  // re-authenticate (and so the user is not prompted twice for a passphrase
  // on subscription auth).
  registerDefaultProviders();

  const authResult = await authenticateProvider({
    flowDir: dirname(flowRef.flowPath),
  });
  if (authResult.isErr()) {
    process.stderr.write(formatError(authResult.error) + '\n');
    process.exit(exitCodeFor(authResult.error));
  }
  const { resolvedProvider, authState } = authResult.value;

  // ---- (6) Resolve the paused ask step ----
  const awaitingInput: AwaitingInput | undefined = state.awaitingInput;

  // Find the paused step id — prefer awaitingInput.stepId, fall back to
  // scanning steps for any step with status 'paused'.
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
    // usage-error: formatError does not apply — corrupt/unexpected state shape, not a PipelineError type
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
    // --json mode: parse and validate
    let parsed: unknown;
    try {
      parsed = JSON.parse(options.json);
    } catch {
      // usage-error: formatError does not apply — bad CLI flag value, not a PipelineError type
      process.stderr.write(red(`  ${SYMBOLS.fail} --json value is not valid JSON`) + '\n');
      process.exit(1);
    }

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      // usage-error: formatError does not apply — bad CLI flag value shape, not a PipelineError type
      process.stderr.write(red(`  ${SYMBOLS.fail} --json value must be a JSON object`) + '\n');
      process.exit(1);
    }

    answers = parsed as AnswerMap;

    const missing = collectMissingRequired(questions, answers);
    if (missing.length > 0) {
      // usage-error: formatError does not apply — missing required answer fields, not a PipelineError type
      process.stderr.write(
        red(`  ${SYMBOLS.fail} missing answers for: ${missing.join(', ')}`) + '\n',
      );
      process.exit(1);
    }
  } else {
    // Interactive mode
    if (questions.length === 0) {
      // No questions — write empty answers and proceed.
      answers = {};
    } else {
      const rl = makeReadline();
      answers = {};
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
  // We write directly via atomicWriteJson rather than HandoffStore.write
  // because the answer key (__ask_<stepId>__) starts with underscores, which
  // HandoffStore.write rejects. The file lands at the exact same path that
  // HandoffStore.read (in executeAsk) resolves to, so the orchestrator's
  // resume sweep picks it up correctly.
  //
  // When the paused step is inside a loop body, the answer must go to the
  // iteration-scoped subdirectory so that answer files from different
  // iterations do not collide. The loopStepId and loopIter fields on
  // awaitingInput carry the routing information; the bare body step id is
  // derived by stripping the "<loopStepId>::" prefix from the synthesised key.
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
    // usage-error: formatError does not apply — AtomicWriteError from atomicWriteJson is not a PipelineError type
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
    // usage-error: formatError does not apply — StateMachine transition error is not a PipelineError type
    process.stderr.write(
      red(
        `  ${SYMBOLS.fail} could not transition step ${pausedStepId} to pending: ${resumeResult.error.message}`,
      ) + '\n',
    );
    process.exit(1);
  }

  const saveResult = await machine.save();
  if (saveResult.isErr()) {
    // usage-error: formatError does not apply — AtomicWriteError from machine.save is not a PipelineError type
    process.stderr.write(
      red(`  ${SYMBOLS.fail} could not persist run state: ${saveResult.error.message}`) + '\n',
    );
    process.exit(EXIT_CODES.io_error);
  }

  // ---- (10) Auto-resume the orchestrator ----
  const orchestrator = new Orchestrator({ runDir });

  const preAuthedMap = new Map<string, AuthState>();
  preAuthedMap.set(resolvedProvider.name, authState);

  let exitCode = 0;
  try {
    const result = await orchestrator.resume(runDir, {
      logToStdout: !process.stdout.isTTY,
      preAuthedState: preAuthedMap,
    });

    if (result.status === 'paused') {
      // A subsequent ask step paused the run again.
      const nextStepId = result.pausedStepId ?? 'unknown';
      process.stdout.write(
        yellow(`  ${SYMBOLS.warn} run paused again at step ${nextStepId}`) + '\n',
      );
      process.stdout.write(gray(`  provide answers with: relay answer ${runId}`) + '\n');
      exitCode = EXIT_CODES.paused;
    } else if (result.status === 'succeeded') {
      process.stdout.write(`  ${SYMBOLS.ok} run ${runId} completed\n`);
    } else {
      // failed or aborted
      // usage-error: formatError does not apply — run terminal status (failed/aborted) is not a PipelineError type
      process.stderr.write(
        red(`  ${SYMBOLS.fail} run ${runId} ${result.status} after resume`) + '\n',
      );
      process.stderr.write(gray(`  relay logs ${runId}`) + '\n');
      exitCode = 1;
    }
  } catch (caught) {
    const msg = caught instanceof Error ? caught.message : String(caught);
    // usage-error: formatError does not apply — unknown thrown value from orchestrator.resume, no PipelineError type
    process.stderr.write(red(`  ${SYMBOLS.fail} resume error: ${msg}`) + '\n');
    exitCode = 1;
  }

  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
