/**
 * ClaudeCliProvider — the subprocess-backed Provider that spawns `claude -p`.
 *
 * Wraps the `claude` binary's stream-json output. The provider uses the auth
 * inspector (`inspectClaudeAuth`) and env allowlist builder
 * (`buildEnvAllowlist`) so the TOS-leak surface (a stray `ANTHROPIC_API_KEY`
 * in the host env) is stripped at the subprocess boundary.
 *
 * Translator: the stream-json envelopes from `claude -p` have stable
 * snake_case shapes — `system`, `assistant`, `user`, `result`, plus the
 * `stream_event` wrapper that carries wire-level Messages-API streaming
 * events (text deltas, turn boundaries) one level deeper. The local
 * `claude-cli/translate.ts` module handles every envelope type directly;
 * the translator unwraps `stream_event` before delegating to the same
 * handlers used for top-level envelopes, preserving token-level streaming
 * for the live progress display.
 *
 * Design invariants:
 *   - authenticate() delegates to `inspectClaudeAuth()`; never inlines auth
 *     checks. ANTHROPIC_API_KEY-only environments fail with the
 *     subscription-remediation message the inspector produced.
 *   - invoke() and stream() share the private #iterate() generator; there is
 *     one subprocess spawn per invocation, no duplicated `claude -p` calls.
 *   - The env passed to runClaudeProcess always comes from
 *     `buildEnvAllowlist({ extra })` — that builder force-strips
 *     ANTHROPIC_API_KEY at the boundary regardless of what is in process.env.
 *     This is mandatory for TOS safety.
 *   - Abort plumbing: the InvocationContext.abortSignal is forwarded straight
 *     to runClaudeProcess; no extra AbortController is constructed.
 *   - No provider-level retries. Step retries are owned by the Orchestrator.
 *   - On non-zero exit, classifyExit produces a typed PipelineError; stream()
 *     emits a stream.error event instead of throwing; invoke() returns err(...)
 *     — neither path throws to the caller.
 */

import { err, ok, type Result } from 'neverthrow';

import { PipelineError, StepFailureError } from '../../errors.js';
import type {
  AuthState,
  InvocationContext,
  InvocationEvent,
  InvocationRequest,
  InvocationResponse,
  NormalizedUsage,
  Provider,
  ProviderCapabilities,
} from '../types.js';
import { buildCliArgs, type ClaudeCliProviderOptions } from './args.js';
import { inspectClaudeAuth } from './auth.js';
import { classifyExit } from './classify-exit.js';
import { buildEnvAllowlist } from './env.js';
import { type RunClaudeProcessResult, runClaudeProcess } from './process.js';
import { extractResultSummary, mergeUsage, translateCliMessage } from './translate.js';

// ---------------------------------------------------------------------------
// Capabilities — published to the Orchestrator so static capability checks can
// run at flow-load time, before any tokens are spent.
// ---------------------------------------------------------------------------

const CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  structuredOutput: true,
  tools: true,
  builtInTools: [
    'Read',
    'Write',
    'Edit',
    'Glob',
    'Grep',
    'Bash',
    'WebFetch',
    'WebSearch',
    'Task',
    'TodoWrite',
  ],
  multimodal: true,
  budgetCap: true,
  models: ['haiku', 'sonnet', 'opus', 'claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7'],
  maxContextTokens: 200_000,
};

const DEFAULT_BINARY = 'claude';

/**
 * Tuple yielded by the private invocation iterator: the raw NDJSON envelope
 * alongside its translated events. stream() discards the raw envelope; invoke()
 * keeps the last `result` envelope for response-level metadata extraction.
 */
interface InvocationStep {
  readonly raw: unknown;
  readonly events: readonly InvocationEvent[];
}

export class ClaudeCliProvider implements Provider {
  readonly name = 'claude-cli' as const;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;

  readonly #options: ClaudeCliProviderOptions;

  constructor(options: ClaudeCliProviderOptions = {}) {
    this.#options = options;
  }

  async authenticate(): Promise<Result<AuthState, PipelineError>> {
    return inspectClaudeAuth();
  }

  /**
   * Shared iterator behind both stream() and invoke(). Spawns one
   * `claude -p` subprocess, threads NDJSON envelopes through the translator,
   * and yields (raw, events) pairs per envelope. Per-stream state (tool
   * id-to-name correlation, monotonic turn counter) is resolved into the
   * translated events here so downstream consumers never see the 'unknown'
   * tool-name placeholder or the 0-turn sentinel when a real value exists.
   *
   * On a non-zero exit the generator throws the PipelineError produced by
   * classifyExit. Both callers catch that throw at the boundary: invoke()
   * converts it to err(...), stream() converts it to a terminal stream.error
   * event — neither path surfaces a raw exception to external callers. On
   * clean exit the generator returns the RunClaudeProcessResult so invoke()
   * can read the final exit code while keeping stream()'s contract free of
   * terminal values.
   */
  async *#iterate(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): AsyncGenerator<InvocationStep, RunClaudeProcessResult, void> {
    const env = buildEnvAllowlist({
      ...(this.#options.extraEnv !== undefined ? { extra: this.#options.extraEnv } : {}),
    });
    const cliArgs = buildCliArgs(req, this.#options);
    const binary = this.#options.binaryPath ?? DEFAULT_BINARY;

    ctx.logger.debug(
      { stepId: ctx.stepId, attempt: ctx.attempt, binary, argCount: cliArgs.length },
      'claude-cli stream opening',
    );

    // Per-stream state, scoped to a single subprocess invocation:
    //   - toolNames correlates tool.result events back to the tool.call that
    //     declared their name (the wire-level events only carry tool_use_id
    //     on results).
    //   - turnCounter is a monotonic fallback used only when the stream omits
    //     a turn number on a turn boundary event.
    const toolNames = new Map<string, string>();
    let turnCounter = 0;

    const subprocess = runClaudeProcess({
      binary,
      cliArgs,
      env,
      prompt: req.prompt,
      abortSignal: ctx.abortSignal,
      logger: ctx.logger,
      ...(ctx.cwd !== undefined ? { cwd: ctx.cwd } : {}),
    });

    let exitResult: RunClaudeProcessResult = {
      exitCode: null,
      stderr: '',
      signal: null,
    };

    while (true) {
      const next = await subprocess.next();
      if (next.done === true) {
        exitResult = next.value;
        break;
      }

      const raw = next.value;
      const translated = translateCliMessage(raw);
      const events: InvocationEvent[] = [];

      for (const event of translated) {
        if (event.type === 'tool.call') {
          if (event.toolUseId !== undefined) {
            toolNames.set(event.toolUseId, event.name);
          }
          events.push(event);
          continue;
        }

        if (event.type === 'tool.result') {
          const resolved =
            event.toolUseId !== undefined
              ? (toolNames.get(event.toolUseId) ?? 'unknown')
              : 'unknown';
          events.push({ ...event, name: resolved });
          continue;
        }

        if (event.type === 'turn.start') {
          if (event.turn === 0) {
            turnCounter += 1;
            events.push({ ...event, turn: turnCounter });
          } else {
            turnCounter = event.turn;
            events.push(event);
          }
          continue;
        }

        if (event.type === 'turn.end') {
          if (event.turn === 0) {
            const turn = turnCounter === 0 ? 1 : turnCounter;
            events.push({ ...event, turn });
          } else {
            events.push(event);
          }
          continue;
        }

        events.push(event);
      }

      yield { raw, events };
    }

    // Translate the terminal exit envelope into either a clean return (so
    // invoke() can read the result) or a thrown PipelineError. Both callers
    // catch at the boundary: invoke() returns err(...), stream() yields a
    // stream.error event. Neither exposes the throw to external callers.
    const error = classifyExit({
      exitCode: exitResult.exitCode,
      stderr: exitResult.stderr,
      aborted: ctx.abortSignal.aborted,
      stepId: ctx.stepId,
      attempt: ctx.attempt,
      providerName: this.name,
    });

    if (error !== null) {
      throw error;
    }

    return exitResult;
  }

  async *stream(req: InvocationRequest, ctx: InvocationContext): AsyncIterable<InvocationEvent> {
    try {
      for await (const step of this.#iterate(req, ctx)) {
        for (const event of step.events) {
          yield event;
        }
      }
    } catch (cause) {
      // stream() promises a pure-data channel to its caller. Any failure in
      // #iterate() — classifyExit's terminal PipelineError, or an upstream
      // contract violation producing some other throw — is funnelled into a
      // terminal stream.error event so the caller never has to wrap the
      // async-iterator in a try/catch.
      const error =
        cause instanceof PipelineError
          ? cause
          : new StepFailureError(
              cause instanceof Error ? cause.message : String(cause),
              ctx.stepId,
              ctx.attempt,
              { cause, providerName: this.name },
            );
      const errorEvent: InvocationEvent = { type: 'stream.error', error };
      yield errorEvent;
    }
  }

  async invoke(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): Promise<Result<InvocationResponse, PipelineError>> {
    const startedAt = Date.now();

    let accumulatedText = '';
    let usage: NormalizedUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    };
    let fallbackTurnCount = 0;
    let lastRawMessage: unknown;
    let lastResultMessage: unknown;
    let streamCostUsd: number | undefined;

    try {
      for await (const step of this.#iterate(req, ctx)) {
        lastRawMessage = step.raw;
        if (isResultMessage(step.raw)) {
          lastResultMessage = step.raw;
        }

        for (const event of step.events) {
          switch (event.type) {
            case 'text.delta':
              accumulatedText += event.delta;
              break;
            case 'usage':
              usage = mergeUsage(usage, event.usage);
              break;
            case 'turn.end':
              fallbackTurnCount += 1;
              break;
            case 'stream.end':
              if (event.costUsd !== undefined) {
                streamCostUsd = event.costUsd;
              }
              break;
            default:
              break;
          }
        }
      }
    } catch (cause) {
      // The only thrown values from #iterate() are PipelineErrors produced by
      // classifyExit — every other failure mode (malformed lines, spawn
      // failure) is captured as a terminal-value envelope inside the
      // subprocess step. A non-PipelineError here would mean a contract
      // violation upstream. invoke() must never throw per the Provider
      // contract, so wrap any non-PipelineError in a StepFailureError and
      // return it via err(...) instead of rethrowing.
      if (isPipelineError(cause)) {
        return err(cause);
      }
      return err(
        new StepFailureError(
          cause instanceof Error ? cause.message : String(cause),
          ctx.stepId,
          ctx.attempt,
          { cause, providerName: this.name },
        ),
      );
    }

    // The result envelope is the source of truth for response-level metadata.
    // The request's model is only used as a fallback if the envelope omits it.
    // costUsd rides on the translated stream.end event; the provider does not
    // re-read the raw envelope to recover it.
    const summary = extractResultSummary(lastResultMessage);

    const response: InvocationResponse = {
      text: accumulatedText,
      usage,
      durationMs: Date.now() - startedAt,
      numTurns: summary?.numTurns ?? fallbackTurnCount,
      model: summary?.model ?? req.model ?? '',
      stopReason: summary?.stopReason ?? null,
      raw: lastRawMessage,
    };

    if (summary?.sessionId !== undefined) {
      response.sessionId = summary.sessionId;
    }
    if (streamCostUsd !== undefined) {
      response.costUsd = streamCostUsd;
    }

    return ok(response);
  }
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isResultMessage(msg: unknown): boolean {
  return isRecord(msg) && msg['type'] === 'result';
}

/**
 * Lightweight duck-type check for PipelineError. We avoid `instanceof`
 * across module boundaries so transpilation or duplicated error classes
 * (rare but possible in test harnesses) do not cause silent rethrows.
 */
function isPipelineError(value: unknown): value is PipelineError {
  if (!isRecord(value)) return false;
  return (
    typeof value['code'] === 'string' &&
    typeof value['message'] === 'string' &&
    typeof value['name'] === 'string'
  );
}
