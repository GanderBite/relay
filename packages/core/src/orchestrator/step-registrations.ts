import { join } from 'node:path';

import { FlowDefinitionError } from '../errors.js';

import { type AskStepResult, executeAsk } from './exec/ask.js';
import { executeBranch } from './exec/branch.js';
import { executeLoop } from './exec/loop.js';
import { executeParallel } from './exec/parallel.js';
import { executePrompt } from './exec/prompt.js';
import { executeScript } from './exec/script.js';
import { executeTerminal } from './exec/terminal.js';
import { writeLiveState } from './live-state.js';
import { defaultStepRegistry, type StepKindRegistry } from './step-kind-registry.js';

/**
 * Register the seven built-in step kinds against `registry`. Each entry wires
 * a per-kind executor to the unified `StepDispatchContext` the orchestrator
 * builds per dispatch.
 *
 * Idempotent — re-importing this module (or calling this function manually
 * with `defaultStepRegistry`) on an already-populated registry is a no-op.
 * Without this guard, a host that imports `step-registrations.ts` from both
 * its own bootstrap and the orchestrator entrypoint would crash on the
 * registry's "already registered" check.
 */
export function registerBuiltInStepKinds(registry: StepKindRegistry): void {
  if (registry.has('prompt')) return;

  registry.register({
    kind: 'prompt',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) => {
      const stepProvider = ctx.providerByStep.get(step.id);
      if (stepProvider === undefined) {
        throw new FlowDefinitionError(`no provider resolved for prompt step "${step.id}"`, {
          stepId: step.id,
        });
      }
      return executePrompt(step, {
        runDir: ctx.runDir,
        flowDir: ctx.flowDir,
        flowName: ctx.flowName,
        runId: ctx.runId,
        stepId: step.id,
        attempt: ctx.attempt,
        abortSignal: ctx.abortSignal,
        handoffStore: ctx.handoffStore,
        costTracker: ctx.costTracker,
        logger: ctx.logger,
        provider: stepProvider,
        inputVars: ctx.inputVars,
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
        ...(ctx.verbose !== undefined ? { verbose: ctx.verbose } : {}),
      });
    },
  });

  registry.register({
    kind: 'script',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) =>
      executeScript(step, {
        runDir: ctx.runDir,
        runId: ctx.runId,
        stepId: step.id,
        attempt: ctx.attempt,
        abortSignal: ctx.abortSignal,
        logger: ctx.logger,
        input: ctx.inputVars,
        handoffStore: ctx.handoffStore,
        flowDir: ctx.flowDir,
        handoffsDir: join(ctx.runDir, 'handoffs'),
      }),
  });

  registry.register({
    kind: 'branch',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) =>
      executeBranch(step, {
        runDir: ctx.runDir,
        runId: ctx.runId,
        stepId: step.id,
        attempt: ctx.attempt,
        abortSignal: ctx.abortSignal,
        logger: ctx.logger,
        input: ctx.inputVars,
        handoffStore: ctx.handoffStore,
        flowDir: ctx.flowDir,
        handoffsDir: join(ctx.runDir, 'handoffs'),
      }),
  });

  registry.register({
    kind: 'parallel',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) =>
      executeParallel(step, {
        stepId: step.id,
        runId: ctx.runId,
        step,
        attempt: ctx.attempt,
        abortSignal: ctx.abortSignal,
        logger: ctx.logger,
        // Branches reuse the orchestrator's full step pipeline (state
        // transitions, retries, executor selection) via dispatchStep so a
        // branch with its own maxRetries/timeoutMs is honored.
        dispatch: (branchStepId) => ctx.dispatchStep(branchStepId),
        // On retry or resume some branches may already be 'succeeded'.
        // Re-dispatching trips startStep's pending-only guard, so the
        // executor short-circuits via these snapshots.
        getBranchStatus: (branchStepId) => ctx.getBranchStatus(branchStepId),
        getBranchResult: (branchStepId) => ctx.getBranchResult(branchStepId),
        // Surface the first failed branch as a typed sibling-failure abort
        // cause so RunResult.abortReason can carry the originating branch id
        // when the run terminates as aborted. The notifier only records the
        // cause; aggregate failure still surfaces through the regular
        // StepFailureError path.
        onBranchFailure: (branchStepId) => ctx.signalSiblingFailureAbort(branchStepId),
      }),
  });

  registry.register({
    kind: 'terminal',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) =>
      executeTerminal(step, {
        flow: ctx.flow,
        runDir: ctx.runDir,
        runId: ctx.runId,
        flowName: ctx.flowName,
        flowDir: ctx.flowDir,
        stepId: step.id,
        attempt: ctx.attempt,
        abortSignal: ctx.abortSignal,
        handoffStore: ctx.handoffStore,
        costTracker: ctx.costTracker,
        stateMachine: ctx.stateMachine,
        logger: ctx.logger,
        providers: ctx.providers,
        provider: ctx.provider,
        ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
      }),
  });

  registry.register({
    kind: 'loop',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) =>
      executeLoop(step, {
        runDir: ctx.runDir,
        stepId: step.id,
        abortSignal: ctx.abortSignal,
        handoffStore: ctx.handoffStore,
        logger: ctx.logger,
        dispatch: (bodyStepId, bodyStep, loopIter) =>
          ctx.dispatchBodyStep(bodyStepId, bodyStep, loopIter, step.id),
        getResumedIter: () => ctx.getResumedLoopIter(step.id),
        onIterationStart: async (iter) => {
          await ctx.onLoopIterationStart(step.id, iter);
          const now = new Date().toISOString();
          void writeLiveState(ctx.runDir, step.id, {
            status: 'running',
            attempt: ctx.attempt,
            startedAt: now,
            lastUpdateAt: now,
            maxIter: step.maxIterations,
            iter,
          });
        },
        isBodyStepSucceeded: (loopStepId, bodyStepId, iter) =>
          ctx.isLoopBodyStepSucceeded(loopStepId, bodyStepId, iter),
      }),
  });

  registry.register({
    kind: 'ask',
    synthesize: (raw, id) => ({ ...raw, id }),
    execute: async (step, ctx) => {
      // executeAsk throws AwaitingInputSignal on the first pass (no answer
      // file present yet) so the orchestrator can pause the run, and returns
      // ok(answerMap) on the resume pass once the answer file is on disk.
      // The signal propagates up through withRetry and is intercepted in
      // dispatchStep's catch; the resume pass falls through to the normal
      // completeStep path. After reading the answer map, the answer is
      // published as a regular handoff under the ask step's id so downstream
      // steps can consume it via `contextFrom: ['<askStepId>']` exactly like
      // a prompt step's output. The on-disk __ask_<stepId>__ file remains
      // the input the CLI writes; the <stepId> handoff is the canonical
      // output the DAG sees.
      const askResult = await executeAsk(step, ctx.handoffStore, step.id, ctx.runDir);
      if (askResult.isErr()) throw askResult.error;
      const answers = askResult.value;
      const writeResult = await ctx.handoffStore.write<unknown>(
        step.id,
        answers,
        step.output?.schema,
      );
      if (writeResult.isErr()) throw writeResult.error;
      const result: AskStepResult = {
        kind: 'ask',
        stepId: step.id,
        answers,
        handoffs: [step.id],
      };
      return result;
    },
  });
}

// Side-effect registration so a single import of this module populates the
// shared default registry. Idempotent via the `has(...)` guard inside
// registerBuiltInStepKinds.
registerBuiltInStepKinds(defaultStepRegistry);
