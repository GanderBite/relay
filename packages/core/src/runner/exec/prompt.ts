import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type {
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
} from '../../providers/types.js';
import type { PromptStepSpec } from '../../flow/types.js';
import type { CostTracker, StepMetrics } from '../../cost.js';
import type { HandoffStore } from '../../handoffs.js';
import type { Logger } from '../../logger.js';
import { assemblePrompt, loadHandoffValues } from '../../context-inject.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { safeParse } from '../../util/json.js';
import {
  HandoffSchemaError,
  PipelineError,
  StepFailureError,
} from '../../errors.js';
import { writeLiveState } from '../live-state.js';
import { z } from '../../zod.js';

/**
 * Context bag threaded into executePrompt. The Runner constructs this from its
 * StepExecutionContext; tests pass a flat object with the same shape. The
 * executor does not reach back into the StateMachine or ProviderRegistry —
 * the provider is resolved upstream and handed in as a ready-to-invoke
 * instance so unit tests can swap in MockProvider without wiring a registry.
 */
export interface PromptStepExecContext {
  runDir: string;
  flowDir: string;
  flowName: string;
  runId: string;
  stepId: string;
  attempt: number;
  abortSignal: AbortSignal;
  handoffStore: HandoffStore;
  costTracker: CostTracker;
  logger: Logger;
  provider: Provider;
  inputVars?: Record<string, unknown>;
  stepVars?: Record<string, unknown>;
}

export interface PromptStepResult {
  kind: 'prompt';
  stepId: string;
  text: string;
  handoffs: string[];
  artifacts: string[];
  tokensIn: number;
  tokensOut: number;
  costUsd: number | undefined;
  durationMs: number;
  numTurns: number;
  model: string;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function codeOf(cause: unknown): string | undefined {
  if (cause instanceof PipelineError) return cause.code;
  if (cause instanceof Error && 'code' in cause && typeof cause.code === 'string') {
    return cause.code;
  }
  return undefined;
}

/**
 * Resolves the prompt template path relative to the flow directory, refusing
 * absolute paths and any traversal that escapes the flow root. Returning the
 * error as a value (vs. throwing) keeps the caller's single catch-site as the
 * only place that wraps into StepFailureError.
 */
function resolvePromptPath(flowDir: string, promptFile: string): string {
  if (isAbsolute(promptFile)) {
    throw new Error(`promptFile must be relative to the flow directory: ${promptFile}`);
  }
  const root = resolve(flowDir);
  const full = resolve(flowDir, promptFile);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error(`promptFile escapes flow directory: ${promptFile}`);
  }
  return full;
}

function toJsonSchema(schema: z.ZodType | undefined): Record<string, unknown> | undefined {
  if (schema === undefined) return undefined;
  const out = z.toJSONSchema(schema);
  if (typeof out !== 'object' || out === null) return undefined;
  return out as Record<string, unknown>;
}

function mergeUsage(base: NormalizedUsage, patch: Partial<NormalizedUsage>): NormalizedUsage {
  return {
    inputTokens: patch.inputTokens ?? base.inputTokens,
    outputTokens: patch.outputTokens ?? base.outputTokens,
    cacheReadTokens: patch.cacheReadTokens ?? base.cacheReadTokens,
    cacheCreationTokens: patch.cacheCreationTokens ?? base.cacheCreationTokens,
  };
}

/**
 * Streams the provider invocation when stream() is available, aggregating
 * text deltas, usage, and turn counts into a single InvocationResponse so the
 * rest of the executor can treat stream and non-stream providers identically.
 * On every usage event (and once on the first text delta as a liveness ping)
 * the per-step live file at <runDir>/live/<stepId>.json is rewritten — that
 * file is the lowest-cadence signal the CLI progress display watches.
 * Providers without stream() fall back to invoke(); the live-state write
 * still lands once after the response is aggregated so the file shape stays
 * consistent across provider implementations.
 */
async function runProviderInvocation(args: {
  provider: Provider;
  request: InvocationRequest;
  invocationCtx: InvocationContext;
  runDir: string;
  stepId: string;
  attempt: number;
  startedIso: string;
  logger: Logger;
}): Promise<InvocationResponse> {
  const { provider, request, invocationCtx, runDir, stepId, attempt, startedIso, logger } = args;

  const emitLive = async (usage: NormalizedUsage, turns: number, model: string): Promise<void> => {
    const tokensSoFar = usage.inputTokens + usage.outputTokens;
    const partial = {
      status: 'running' as const,
      attempt,
      startedAt: startedIso,
      lastUpdateAt: new Date().toISOString(),
      tokensSoFar,
      turnsSoFar: turns,
      ...(model !== '' ? { model } : {}),
    };
    const write = await writeLiveState(runDir, stepId, partial);
    if (write.isErr()) {
      logger.warn(
        { event: 'live-state.write_failed', stepId, error: write.error.message },
        'live state write failed; continuing',
      );
    }
  };

  if (typeof provider.stream === 'function') {
    const started = Date.now();
    let accumulatedText = '';
    let usage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let turnCount = 0;
    const model = request.model ?? '';
    let firstDeltaSeen = false;
    // Fallback sentinel for providers whose stream never emits stream.end
    // (custom providers, older test doubles). The canonical Claude provider
    // always emits stream.end from its result-message translation path.
    let capturedStopReason = 'stream_completed';

    const iterable = provider.stream(request, invocationCtx);
    for await (const event of iterable) {
      switch (event.type) {
        case 'text.delta':
          accumulatedText += event.delta;
          if (!firstDeltaSeen) {
            firstDeltaSeen = true;
            await emitLive(usage, turnCount, model);
          }
          break;
        case 'usage':
          usage = mergeUsage(usage, event.usage);
          await emitLive(usage, turnCount, model);
          break;
        case 'turn.end':
          turnCount = Math.max(turnCount, event.turn);
          break;
        case 'stream.end':
          capturedStopReason = event.stopReason;
          break;
        default:
          break;
      }
    }

    return {
      text: accumulatedText,
      usage,
      durationMs: Date.now() - started,
      numTurns: turnCount,
      model,
      stopReason: capturedStopReason,
    };
  }

  // Provider does not expose stream(); fall back to the single-shot
  // invoke() and still emit one live-state update after the call returns.
  const result = await provider.invoke(request, invocationCtx);
  if (result.isErr()) throw result.error;
  const response = result.value;
  await emitLive(response.usage, response.numTurns, response.model);
  return response;
}

/**
 * Schema-validation failures keep their class so the Runner (and tests) can
 * discriminate a handoff-shape bug from a provider/network failure. Every
 * other non-StepFailureError cause is wrapped so the retry loop only has one
 * error type to dispatch on.
 */
function wrapFailure(
  cause: unknown,
  stepId: string,
  attempt: number,
): PipelineError {
  if (cause instanceof StepFailureError) return cause;
  if (cause instanceof HandoffSchemaError) return cause;
  const message = messageOf(cause);
  return new StepFailureError(
    `step "${stepId}" failed: ${message}`,
    stepId,
    attempt,
    { cause: message, code: codeOf(cause) },
  );
}

/**
 * Executes one prompt step. Loads the template, injects declared handoffs,
 * invokes the provider, then routes the response to a handoff (validated via
 * Zod when a schema is configured) and/or an artifact file. Cost metrics are
 * recorded on success; any upstream failure is wrapped in StepFailureError so
 * the Runner's retry loop sees a single error class.
 */
export async function executePrompt(
  step: PromptStepSpec,
  ctx: PromptStepExecContext,
): Promise<PromptStepResult> {
  const stepId = ctx.stepId;
  const attempt = ctx.attempt ?? 1;
  const started = Date.now();

  ctx.logger.info(
    {
      event: 'prompt.start',
      stepId,
      model: step.model,
      provider: ctx.provider.name,
    },
    'prompt step started',
  );

  const startedIso = new Date(started).toISOString();

  try {
    // 1. Load the prompt template file from the flow directory.
    const promptPath = resolvePromptPath(ctx.flowDir, step.promptFile);
    const promptBody = await readFile(promptPath, 'utf8');

    // 2. Load declared handoff values in declaration order.
    const contextFrom = step.contextFrom ?? [];
    const handoffsResult = await loadHandoffValues(ctx.handoffStore, contextFrom);
    if (handoffsResult.isErr()) throw handoffsResult.error;

    // 3. Assemble the final prompt with <context> blocks + rendered template.
    const assembled = assemblePrompt({
      promptBody,
      handoffs: handoffsResult.value,
      inputVars: ctx.inputVars ?? {},
      stepVars: ctx.stepVars,
    });
    if (assembled.isErr()) throw assembled.error;

    // 4. Convert the optional output schema to JSON schema for the provider.
    const schema = 'schema' in step.output ? step.output.schema : undefined;
    const jsonSchema = toJsonSchema(schema);

    // Pre-flight finished — only now is the step actually invoking the
    // provider. Writing 'running' before handoff load / prompt assembly would
    // leave a zombie running file in live/ when those pre-flight steps fail
    // and the catch block rethrows without a terminal write-back.
    const liveStartResult = await writeLiveState(ctx.runDir, stepId, {
      status: 'running',
      attempt,
      startedAt: startedIso,
      lastUpdateAt: startedIso,
      ...(step.model !== undefined ? { model: step.model } : {}),
    });
    if (liveStartResult.isErr()) {
      ctx.logger.warn(
        { event: 'live-state.write_failed', stepId, error: liveStartResult.error.message },
        'live state write failed; continuing',
      );
    }

    // 5. Build the invocation request + context.
    const request: InvocationRequest = {
      prompt: assembled.value,
      ...(step.model !== undefined ? { model: step.model } : {}),
      ...(step.systemPrompt !== undefined ? { systemPrompt: step.systemPrompt } : {}),
      ...(step.tools !== undefined ? { tools: step.tools } : {}),
      ...(jsonSchema !== undefined ? { jsonSchema } : {}),
      ...(step.maxBudgetUsd !== undefined ? { maxBudgetUsd: step.maxBudgetUsd } : {}),
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
      ...(step.providerOptions !== undefined
        ? { providerOptions: step.providerOptions }
        : {}),
    };

    const invocationCtx: InvocationContext = {
      flowName: ctx.flowName,
      runId: ctx.runId,
      stepId,
      attempt,
      abortSignal: ctx.abortSignal,
      logger: ctx.logger,
    };

    // 6. Stream the provider invocation and aggregate events inline. Using
    // stream() (falling back to invoke() when the provider does not expose
    // one) lets the executor update <runDir>/live/<stepId>.json on every
    // token-usage event, which is what the CLI progress display watches to
    // animate counters within a long-running step. The outer try/catch covers
    // both the stream iterator's thrown errors and invoke()'s Result.err
    // branch so every upstream surface funnels into wrapFailure identically.
    const response = await runProviderInvocation({
      provider: ctx.provider,
      request,
      invocationCtx,
      runDir: ctx.runDir,
      stepId,
      attempt,
      startedIso,
      logger: ctx.logger,
    });

    // Record usage as soon as the provider returns so CostTracker captures
    // tokens even if downstream handoff/artifact writes fail.
    ctx.logger.info(
      {
        event: 'prompt.usage',
        stepId,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
      },
      'prompt usage recorded',
    );

    // Handoff routing: parse JSON, validate against schema if configured,
    // then write via the HandoffStore. Validate before persist so a
    // schema-mismatched response never lands on disk.
    const handoffs: string[] = [];
    const artifacts: string[] = [];

    if ('handoff' in step.output) {
      const handoffKey = step.output.handoff;
      const parsedJson = safeParse(response.text);
      if (parsedJson.isErr()) {
        throw new HandoffSchemaError(
          `handoff "${handoffKey}" response is not valid JSON: ${parsedJson.error.message}`,
          handoffKey,
          [],
        );
      }

      if (schema !== undefined) {
        const check = schema.safeParse(parsedJson.value);
        if (!check.success) {
          throw new HandoffSchemaError(
            `handoff "${handoffKey}" failed schema validation`,
            handoffKey,
            check.error.issues,
          );
        }
      }

      const writeResult = await ctx.handoffStore.write(handoffKey, parsedJson.value, schema);
      if (writeResult.isErr()) throw writeResult.error;
      handoffs.push(handoffKey);
    }

    // Artifact routing: write the response text verbatim to
    // <runDir>/artifacts/<name>. atomicWriteText creates parent directories.
    if ('artifact' in step.output) {
      const artifactName = step.output.artifact;
      const artifactPath = join(ctx.runDir, 'artifacts', artifactName);
      const writeResult = await atomicWriteText(artifactPath, response.text);
      if (writeResult.isErr()) throw writeResult.error;
      artifacts.push(artifactPath);
    }

    // Record StepMetrics for CostTracker's summary + metrics.json.
    const metrics: StepMetrics = {
      stepId,
      flowName: ctx.flowName,
      runId: ctx.runId,
      timestamp: new Date().toISOString(),
      model: response.model,
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheCreationTokens: response.usage.cacheCreationTokens,
      numTurns: response.numTurns,
      durationMs: response.durationMs,
      ...(response.costUsd !== undefined ? { costUsd: response.costUsd } : {}),
      ...(response.sessionId !== undefined ? { sessionId: response.sessionId } : {}),
      ...(response.stopReason !== undefined ? { stopReason: response.stopReason } : {}),
    };
    const recordResult = await ctx.costTracker.record(metrics);
    if (recordResult.isErr()) throw recordResult.error;

    ctx.logger.info(
      {
        event: 'prompt.done',
        stepId,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        costUsd: response.costUsd,
        turns: response.numTurns,
        durationMs: Date.now() - started,
      },
      'prompt step completed',
    );

    return {
      kind: 'prompt',
      stepId,
      text: response.text,
      handoffs,
      artifacts,
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
      costUsd: response.costUsd,
      durationMs: response.durationMs,
      numTurns: response.numTurns,
      model: response.model,
    };
  } catch (caught) {
    const wrapped = wrapFailure(caught, stepId, attempt);
    ctx.logger.error(
      {
        event: 'prompt.failed',
        stepId,
        code: codeOf(caught),
        message: messageOf(caught),
        attempt,
      },
      'prompt step failed',
    );
    throw wrapped;
  }
}
