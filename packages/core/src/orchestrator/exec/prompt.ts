import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';

import type {
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
} from '../../providers/types.js';
import type { PromptRunnerSpec } from '../../race/types.js';
import type { CostTracker, RunnerMetrics } from '../../cost.js';
import type { BatonStore } from '../../batons.js';
import type { Logger } from '../../logger.js';
import { assemblePrompt, loadBatonValues } from '../../context-inject.js';
import { atomicWriteText } from '../../util/atomic-write.js';
import { safeParse } from '../../util/json.js';
import {
  BatonSchemaError,
  PipelineError,
  RunnerFailureError,
} from '../../errors.js';
import { writeLiveState } from '../live-state.js';
import { z } from '../../zod.js';

/**
 * Context bag threaded into executePrompt. The Runner constructs this from its
 * RunnerExecutionContext; tests pass a flat object with the same shape. The
 * executor does not reach back into the RaceStateMachine or ProviderRegistry —
 * the provider is resolved upstream and handed in as a ready-to-invoke
 * instance so unit tests can swap in MockProvider without wiring a registry.
 */
export interface PromptRunnerExecContext {
  runDir: string;
  raceDir: string;
  raceName: string;
  runId: string;
  runnerId: string;
  attempt: number;
  abortSignal: AbortSignal;
  batonStore: BatonStore;
  costTracker: CostTracker;
  logger: Logger;
  provider: Provider;
  inputVars?: Record<string, unknown>;
  runnerVars?: Record<string, unknown>;
}

export interface PromptRunnerResult {
  kind: 'prompt';
  runnerId: string;
  text: string;
  batons: string[];
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
 * Resolves the prompt template path relative to the race directory, refusing
 * absolute paths and any traversal that escapes the race root. Returning the
 * error as a value (vs. throwing) keeps the caller's single catch-site as the
 * only place that wraps into RunnerFailureError.
 */
function resolvePromptPath(raceDir: string, promptFile: string): string {
  if (isAbsolute(promptFile)) {
    throw new Error(`promptFile must be relative to the race directory: ${promptFile}`);
  }
  const root = resolve(raceDir);
  const full = resolve(raceDir, promptFile);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (full !== root && !full.startsWith(prefix)) {
    throw new Error(`promptFile escapes race directory: ${promptFile}`);
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
 * the per-step live file at <runDir>/live/<runnerId>.json is rewritten — that
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
  runnerId: string;
  attempt: number;
  startedIso: string;
  logger: Logger;
}): Promise<InvocationResponse> {
  const { provider, request, invocationCtx, runDir, runnerId, attempt, startedIso, logger } = args;

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
    const write = await writeLiveState(runDir, runnerId, partial);
    if (write.isErr()) {
      logger.warn(
        { event: 'live-state.write_failed', runnerId, error: write.error.message },
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
    let capturedCostUsd: number | undefined;
    let capturedSessionId: string | undefined;

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
          capturedCostUsd = event.costUsd;
          capturedSessionId = event.sessionId;
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
      ...(capturedCostUsd !== undefined ? { costUsd: capturedCostUsd } : {}),
      ...(capturedSessionId !== undefined ? { sessionId: capturedSessionId } : {}),
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
 * Schema-validation failures keep their class so the Orchestrator (and tests) can
 * discriminate a baton-shape bug from a provider/network failure. Every
 * other non-RunnerFailureError cause is wrapped so the retry loop only has one
 * error type to dispatch on.
 */
function wrapFailure(
  cause: unknown,
  runnerId: string,
  attempt: number,
): PipelineError {
  if (cause instanceof RunnerFailureError) return cause;
  if (cause instanceof BatonSchemaError) return cause;
  const message = messageOf(cause);
  return new RunnerFailureError(
    `runner "${runnerId}" failed: ${message}`,
    runnerId,
    attempt,
    { cause: message, code: codeOf(cause) },
  );
}

/**
 * Executes one prompt runner. Loads the template, injects declared batons,
 * invokes the provider, then routes the response to a baton (validated via
 * Zod when a schema is configured) and/or an artifact file. Cost metrics are
 * recorded on success; any upstream failure is wrapped in RunnerFailureError so
 * the Orchestrator's retry loop sees a single error class.
 */
export async function executePrompt(
  runner: PromptRunnerSpec,
  ctx: PromptRunnerExecContext,
): Promise<PromptRunnerResult> {
  const runnerId = ctx.runnerId;
  const attempt = ctx.attempt ?? 1;
  const started = Date.now();

  ctx.logger.info(
    {
      event: 'prompt.start',
      runnerId,
      model: runner.model,
      provider: ctx.provider.name,
    },
    'prompt runner started',
  );

  const startedIso = new Date(started).toISOString();

  try {
    // 1. Load the prompt template file from the race directory.
    const promptPath = resolvePromptPath(ctx.raceDir, runner.promptFile);
    const promptBody = await readFile(promptPath, 'utf8');

    // 2. Load declared baton values in declaration order.
    const contextFrom = runner.contextFrom ?? [];
    const batonsResult = await loadBatonValues(ctx.batonStore, contextFrom);
    if (batonsResult.isErr()) throw batonsResult.error;

    // 3. Assemble the final prompt with <context> blocks + rendered template.
    const assembled = assemblePrompt({
      promptBody,
      batons: batonsResult.value,
      inputVars: ctx.inputVars ?? {},
      runnerVars: ctx.runnerVars,
    });
    if (assembled.isErr()) throw assembled.error;

    // 4. Convert the optional output schema to JSON schema for the provider.
    const schema = 'schema' in runner.output ? runner.output.schema : undefined;
    const jsonSchema = toJsonSchema(schema);

    // Pre-flight finished — only now is the runner actually invoking the
    // provider. Writing 'running' before baton load / prompt assembly would
    // leave a zombie running file in live/ when those pre-flight steps fail
    // and the catch block rethrows without a terminal write-back.
    const liveStartResult = await writeLiveState(ctx.runDir, runnerId, {
      status: 'running',
      attempt,
      startedAt: startedIso,
      lastUpdateAt: startedIso,
      ...(runner.model !== undefined ? { model: runner.model } : {}),
    });
    if (liveStartResult.isErr()) {
      ctx.logger.warn(
        { event: 'live-state.write_failed', runnerId, error: liveStartResult.error.message },
        'live state write failed; continuing',
      );
    }

    // 5. Build the invocation request + context.
    const request: InvocationRequest = {
      prompt: assembled.value,
      ...(runner.model !== undefined ? { model: runner.model } : {}),
      ...(runner.systemPrompt !== undefined ? { systemPrompt: runner.systemPrompt } : {}),
      ...(runner.tools !== undefined ? { tools: runner.tools } : {}),
      ...(jsonSchema !== undefined ? { jsonSchema } : {}),
      ...(runner.maxBudgetUsd !== undefined ? { maxBudgetUsd: runner.maxBudgetUsd } : {}),
      ...(runner.timeoutMs !== undefined ? { timeoutMs: runner.timeoutMs } : {}),
    };

    const invocationCtx: InvocationContext = {
      raceName: ctx.raceName,
      runId: ctx.runId,
      runnerId,
      attempt,
      abortSignal: ctx.abortSignal,
      logger: ctx.logger,
    };

    // 6. Stream the provider invocation and aggregate events inline. Using
    // stream() (falling back to invoke() when the provider does not expose
    // one) lets the executor update <runDir>/live/<runnerId>.json on every
    // token-usage event, which is what the CLI progress display watches to
    // animate counters within a long-running runner. The outer try/catch covers
    // both the stream iterator's thrown errors and invoke()'s Result.err
    // branch so every upstream surface funnels into wrapFailure identically.
    const response = await runProviderInvocation({
      provider: ctx.provider,
      request,
      invocationCtx,
      runDir: ctx.runDir,
      runnerId,
      attempt,
      startedIso,
      logger: ctx.logger,
    });

    // Record usage as soon as the provider returns so CostTracker captures
    // tokens even if downstream baton/artifact writes fail.
    ctx.logger.info(
      {
        event: 'prompt.usage',
        runnerId,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
      },
      'prompt usage recorded',
    );

    // Baton routing: parse JSON, validate against schema if configured,
    // then write via the BatonStore. Validate before persist so a
    // schema-mismatched response never lands on disk.
    const batons: string[] = [];
    const artifacts: string[] = [];

    if ('baton' in runner.output) {
      const batonKey = runner.output.baton;
      const parsedJson = safeParse(response.text);
      if (parsedJson.isErr()) {
        throw new BatonSchemaError(
          `baton "${batonKey}" response is not valid JSON: ${parsedJson.error.message}`,
          batonKey,
          [],
        );
      }

      if (schema !== undefined) {
        const check = schema.safeParse(parsedJson.value);
        if (!check.success) {
          throw new BatonSchemaError(
            `baton "${batonKey}" failed schema validation`,
            batonKey,
            check.error.issues,
          );
        }
      }

      const writeResult = await ctx.batonStore.write(batonKey, parsedJson.value, schema);
      if (writeResult.isErr()) throw writeResult.error;
      batons.push(batonKey);
    }

    // Artifact routing: write the response text verbatim to
    // <runDir>/artifacts/<name>. atomicWriteText creates parent directories.
    if ('artifact' in runner.output) {
      const artifactName = runner.output.artifact;
      const artifactPath = join(ctx.runDir, 'artifacts', artifactName);
      const writeResult = await atomicWriteText(artifactPath, response.text);
      if (writeResult.isErr()) throw writeResult.error;
      artifacts.push(artifactPath);
    }

    // Record RunnerMetrics for CostTracker's summary + metrics.json.
    const metrics: RunnerMetrics = {
      runnerId,
      raceName: ctx.raceName,
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
        runnerId,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        costUsd: response.costUsd,
        turns: response.numTurns,
        durationMs: Date.now() - started,
      },
      'prompt runner completed',
    );

    return {
      kind: 'prompt',
      runnerId,
      text: response.text,
      batons,
      artifacts,
      tokensIn: response.usage.inputTokens,
      tokensOut: response.usage.outputTokens,
      costUsd: response.costUsd,
      durationMs: response.durationMs,
      numTurns: response.numTurns,
      model: response.model,
    };
  } catch (caught) {
    const wrapped = wrapFailure(caught, runnerId, attempt);
    ctx.logger.error(
      {
        event: 'prompt.failed',
        runnerId,
        code: codeOf(caught),
        message: messageOf(caught),
        attempt,
      },
      'prompt runner failed',
    );
    throw wrapped;
  }
}
