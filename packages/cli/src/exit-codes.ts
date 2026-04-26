/**
 * Exit code mapper and error formatter for the Relay CLI.
 *
 * Exit codes:
 *   0 — success
 *   1 — step failure (StepFailureError, generic Error, unknown)
 *   2 — flow definition error (FlowDefinitionError, ProviderCapabilityError)
 *   3 — auth error (ClaudeAuthError, ProviderAuthError)
 *   4 — handoff / schema error (HandoffSchemaError)
 *   5 — timeout (TimeoutError, AuthTimeoutError)
 *   6 — no provider configured (NoProviderConfiguredError)
 *   7 — I/O error (AtomicWriteError)
 *   8 — rate limited (ProviderRateLimitError)
 *
 * Error format follows the product spec error template:
 *   ✕ <one-line headline>
 *
 *     <one-sentence explanation>
 *
 *     → <exact command or edit to try next>
 */

import {
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  HandoffSchemaError,
  PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '@ganderbite/relay-core';
import { CommanderError } from 'commander';
import { gray, red } from './color.js';
import { FlowLoadError } from './flow-loader.js';
import { fmtDuration } from './format.js';

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  success: 0,
  runner_failure: 1,
  definition_error: 2,
  auth_error: 3,
  handoff_error: 4,
  timeout: 5,
  no_provider: 6,
  io_error: 7,
  rate_limit: 8,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Two-space indent for body lines. */
const INDENT = '  ';

/** Separator between the headline block and remediations. */
const BLANK = '';

/**
 * Render a remediation line as `  → <command>`.
 * The arrow aligns with the explanation text above it.
 */
function remediation(command: string): string {
  return `${INDENT}→ ${command}`;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * Public handler shape — generic over the specific PipelineError subclass it
 * formats. Each entry in the registry is built via `makeHandler`, which takes
 * an `instanceof` guard so the `format` callback receives a narrowed type
 * without any `as` cast. When the registry's code-string key and the thrown
 * error's class disagree (a class inheritance refactor gone wrong, or a
 * future provider that mints a new subclass under an existing code), the
 * guard fails and a safe generic fallback is emitted instead of silently
 * reading undefined fields.
 */
export type ErrorHandler<T extends PipelineError> = {
  exitCode: number;
  format: (e: T) => string;
};

/**
 * Internal storage shape — the generic parameter is erased so heterogeneous
 * handlers can share one Map. The stored `format` is the wrapper produced by
 * `makeHandler`, which runs the guard before invoking the typed callback.
 */
type RegistryEntry = {
  exitCode: number;
  format: (e: PipelineError) => string;
};

/**
 * Build a registry entry from an `ErrorHandler<T>`. The returned entry's
 * `format` accepts any `PipelineError`, runs the `instanceof` guard, and
 * forwards to the typed callback on match or emits a minimal fallback on
 * mismatch. The fallback should not be observed at runtime — if it is, the
 * registry key and the error's class have drifted and the real fix is at the
 * throw site or the registry entry.
 */
function makeHandler<T extends PipelineError>(
  exitCode: number,
  guard: (e: PipelineError) => e is T,
  format: (e: T) => string,
): RegistryEntry {
  return {
    exitCode,
    format: (e) => {
      if (!guard(e)) return `${e.name}: ${e.message}`;
      return format(e);
    },
  };
}

const errorRegistry = new Map<string, RegistryEntry>([
  // StepFailureError — step exited non-zero
  [
    ERROR_CODES.STEP_FAILURE,
    makeHandler(
      EXIT_CODES.runner_failure,
      (e): e is StepFailureError => e instanceof StepFailureError,
      (err) => {
        const runId = err.details?.runId ?? '<runId>';
        return [
          red(`✕ Step '${err.stepId}' failed on attempt ${err.attempt}`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation(`relay logs ${runId} --step ${err.stepId}        see what went wrong`),
          remediation(`relay resume ${runId}                          retry the step`),
        ].join('\n');
      },
    ),
  ],

  // FlowDefinitionError — with special handling for cycle detection
  [
    ERROR_CODES.FLOW_DEFINITION,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowDefinitionError => e instanceof FlowDefinitionError,
      (err) => {
        const cyclePath = extractCyclePath(err);
        if (cyclePath !== null) {
          return [
            red('✕ Flow has a dependency cycle'),
            BLANK,
            `${INDENT}Steps form a cycle: ${cyclePath}`,
            BLANK,
            remediation(`edit flow.ts to remove the back-edge from ${lastEdge(cyclePath)}`),
          ].join('\n');
        }
        return [
          red(`✕ Flow definition error`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('edit flow.ts to fix the definition error'),
          remediation('relay doctor'),
        ].join('\n');
      },
    ),
  ],

  // ProviderCapabilityError — subclass of FlowDefinitionError, same exit code + format
  [
    ERROR_CODES.PROVIDER_CAPABILITY,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is ProviderCapabilityError => e instanceof ProviderCapabilityError,
      (err) => {
        return [
          red(`✕ Flow definition error`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('edit flow.ts to fix the definition error'),
          remediation('relay doctor'),
        ].join('\n');
      },
    ),
  ],

  // ClaudeAuthError — two distinct shapes
  [
    ERROR_CODES.CLAUDE_AUTH,
    makeHandler(
      EXIT_CODES.auth_error,
      (e): e is ClaudeAuthError => e instanceof ClaudeAuthError,
      (err) => {
        const msg = err.message.toLowerCase();

        // Shape: binary missing
        if (
          msg.includes('binary missing') ||
          msg.includes('not found') ||
          msg.includes('not installed')
        ) {
          return [
            red("✕ 'claude' command not found"),
            BLANK,
            `${INDENT}Relay invokes the Claude CLI. It's not installed on this machine.`,
            BLANK,
            remediation('install: https://claude.com/code/install'),
            remediation('then run: relay doctor'),
          ].join('\n');
        }

        // Shape: subscription credentials missing or binary not found
        return [
          red('✕ Authentication failed — subscription credentials not found'),
          BLANK,
          `${INDENT}${msg}`,
          BLANK,
          remediation('run: claude /login'),
          remediation('relay doctor     full environment check'),
        ].join('\n');
      },
    ),
  ],

  // AuthTimeoutError — must be registered before TimeoutError (same exit code, different format)
  [
    ERROR_CODES.AUTH_TIMEOUT,
    makeHandler(
      EXIT_CODES.timeout,
      (e): e is AuthTimeoutError => e instanceof AuthTimeoutError,
      (err) => {
        const humanTime = fmtDuration(err.timeoutMs);
        return [
          red(`✕ Authentication for provider '${err.providerName}' timed out after ${humanTime}`),
          BLANK,
          `${INDENT}The provider's authentication did not complete within the configured timeout.`,
          `${INDENT}This usually means a misconfigured CLI probe or a network connectivity issue.`,
          BLANK,
          remediation('relay doctor'),
        ].join('\n');
      },
    ),
  ],

  // TimeoutError — runner exceeded its timeoutMs budget
  [
    ERROR_CODES.TIMEOUT,
    makeHandler(
      EXIT_CODES.timeout,
      (e): e is TimeoutError => e instanceof TimeoutError,
      (err) => {
        const stepId = err.stepId;
        const timeoutMs = err.timeoutMs;
        const humanTime = fmtDuration(timeoutMs);

        const runId = err.details?.runId ?? '<runId>';
        const artifactPath =
          err.details?.artifactPath ?? `./.relay/runs/${runId}/artifacts/${stepId}.partial`;

        return [
          red(`✕ Step '${stepId}' timed out after ${humanTime}`),
          BLANK,
          `${INDENT}The prompt ran longer than its configured timeout. This usually means`,
          `${INDENT}the prompt is asking for too much in a single turn, or a tool call is`,
          `${INDENT}hanging.`,
          BLANK,
          remediation(`check the partial output: ${artifactPath}`),
          remediation(`raise the timeout in flow.ts: step.prompt({ timeoutMs: ${timeoutMs * 2} })`),
          remediation(`relay resume ${runId}                      retry with the new config`),
        ].join('\n');
      },
    ),
  ],

  // HandoffSchemaError
  [
    ERROR_CODES.HANDOFF_SCHEMA,
    makeHandler(
      EXIT_CODES.handoff_error,
      (e): e is HandoffSchemaError => e instanceof HandoffSchemaError,
      (err) => {
        const handoffId = err.handoffId;
        const issueLines = err.issues.map((issue) => {
          const pathStr = issue.path.length > 0 ? issue.path.map(String).join('.') : handoffId;
          return `${INDENT}  ${handoffId}${pathStr !== handoffId ? `[${pathStr}]` : ''} ${issue.message}`;
        });

        const runId = err.details?.runId ?? '<runId>';
        const stepName = err.details?.stepName ?? handoffId;
        const promptFile = err.details?.promptFile ?? `prompts/${stepName}.md`;

        return [
          red(`✕ Handoff '${handoffId}' failed schema validation`),
          BLANK,
          `${INDENT}Step '${stepName}' produced JSON that doesn't match its declared schema:`,
          ...issueLines,
          BLANK,
          remediation(`relay logs ${runId} --step ${stepName}        see what Claude produced`),
          remediation(`edit ${promptFile}              tighten the prompt`),
          remediation(`relay resume ${runId}                      retry after fixing`),
        ].join('\n');
      },
    ),
  ],

  // NoProviderConfiguredError — the format function does not access any typed
  // fields, so this entry skips the generic `makeHandler` wrapper and uses the
  // plain RegistryEntry shape directly.
  [
    ERROR_CODES.NO_PROVIDER,
    {
      exitCode: EXIT_CODES.no_provider,
      format: () =>
        [
          red('✕ no provider configured'),
          BLANK,
          `${INDENT}Relay does not know which backend to run your flow on.`,
          BLANK,
          remediation('relay init                            pick a provider interactively'),
          remediation(
            'relay run <flow> --provider claude-cli   use the subscription-safe provider',
          ),
        ].join('\n'),
    },
  ],

  // ProviderAuthError — generic provider auth misconfiguration
  [
    ERROR_CODES.PROVIDER_AUTH,
    makeHandler(
      EXIT_CODES.auth_error,
      (e): e is ProviderAuthError => e instanceof ProviderAuthError,
      (err) => {
        return [
          red(`✕ Authentication failed for provider '${err.providerName}'`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('relay doctor'),
        ].join('\n');
      },
    ),
  ],

  // ProviderRateLimitError — rate limited by provider
  [
    ERROR_CODES.PROVIDER_RATE_LIMIT,
    makeHandler(
      EXIT_CODES.rate_limit,
      (e): e is ProviderRateLimitError => e instanceof ProviderRateLimitError,
      (err) => {
        const runId = err.details?.runId ?? '<runId>';
        return [
          red(`✕ Rate limited by provider '${err.providerName}'`),
          BLANK,
          `${INDENT}The provider returned a rate-limit response on step '${err.stepId}' (attempt ${err.attempt}).`,
          `${INDENT}Wait for the rate limit to reset, then resume the run.`,
          BLANK,
          remediation(`relay resume ${runId}      retry after the rate limit resets`),
        ].join('\n');
      },
    ),
  ],

  // FlowLoadError — FLOW_NOT_FOUND
  [
    ERROR_CODES.FLOW_NOT_FOUND,
    makeHandler(
      EXIT_CODES.runner_failure,
      (e): e is FlowLoadError =>
        e instanceof FlowLoadError && e.code === ERROR_CODES.FLOW_NOT_FOUND,
      (err) =>
        [
          red('✕ Flow not found'),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('relay run <path-to-flow>    specify the correct path'),
        ].join('\n'),
    ),
  ],

  // FlowLoadError — FLOW_INVALID
  [
    ERROR_CODES.FLOW_INVALID,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowLoadError => e instanceof FlowLoadError && e.code === ERROR_CODES.FLOW_INVALID,
      (err) =>
        [
          red('✕ Flow package is invalid'),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('relay doctor    check your environment'),
        ].join('\n'),
    ),
  ],
]);

// ---------------------------------------------------------------------------
// Exit code mapper
// ---------------------------------------------------------------------------

/**
 * Map any thrown value to a CLI exit code.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode;
  if (err instanceof PipelineError) {
    return errorRegistry.get(err.code)?.exitCode ?? EXIT_CODES.runner_failure;
  }
  if (err instanceof Error) return EXIT_CODES.runner_failure;
  return EXIT_CODES.runner_failure;
}

// ---------------------------------------------------------------------------
// formatError
// ---------------------------------------------------------------------------

/**
 * Produce a fully-formatted multi-line error block for stderr.
 *
 * Output shape:
 *   ✕ <headline>          <- red
 *
 *     <explanation>       <- plain, two-space indent
 *
 *     → <command>         <- one per remediation, two-space indent
 *
 * Every shape ends with at least one → line — no dead-ends.
 */
export function formatError(err: unknown): string {
  // ----------------------------------------------------------------
  // CommanderError — unknown command or option
  // ----------------------------------------------------------------
  if (err instanceof CommanderError) {
    return [
      red(`✕ Unknown command or option: ${err.message}`),
      BLANK,
      remediation('relay --help'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // PipelineError — look up the registry by error code
  // ----------------------------------------------------------------
  if (err instanceof PipelineError) {
    const handler = errorRegistry.get(err.code);
    if (handler !== undefined) return handler.format(err);

    // Generic PipelineError fallback for unknown codes
    return [
      red(`✕ ${err.name}: ${err.message}`),
      BLANK,
      `${INDENT}A Relay runtime error occurred ${gray(`[${err.code}]`)}.`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // Generic Error
  // ----------------------------------------------------------------
  if (err instanceof Error) {
    return [
      red(`✕ Unexpected error: ${err.message}`),
      BLANK,
      `${INDENT}An unhandled error occurred. This is likely a bug in Relay or a flow package.`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // Unknown (non-Error throw)
  // ----------------------------------------------------------------
  return [
    red('✕ Unexpected error'),
    BLANK,
    `${INDENT}An unknown value was thrown. This is a bug in a flow package or Relay itself.`,
    BLANK,
    remediation('relay doctor'),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Internal helpers for FlowDefinitionError cycle extraction
// ---------------------------------------------------------------------------

/**
 * Try to extract a cycle path string from a FlowDefinitionError.
 *
 * Reads the structured `details.cyclePath` field (string[] of step ids)
 * populated by the DAG cycle detector. Returns a formatted string like
 * "inventory → entities → services → inventory", or null if this error does
 * not describe a cycle.
 */
function extractCyclePath(err: FlowDefinitionError): string | null {
  const cyclePath = err.details?.cyclePath;
  if (
    Array.isArray(cyclePath) &&
    cyclePath.length >= 2 &&
    cyclePath.every((s): s is string => typeof s === 'string')
  ) {
    return [...cyclePath, cyclePath[0]].join(' → ');
  }

  return null;
}

/**
 * Given a formatted cycle path like "inventory → entities → services → inventory",
 * return the last edge description: "services to inventory".
 */
function lastEdge(cyclePath: string): string {
  const parts = cyclePath.split(' → ').map((s) => s.trim());
  if (parts.length < 2) return cyclePath;
  const last = parts[parts.length - 1] ?? '';
  const secondLast = parts[parts.length - 2] ?? '';
  return `${secondLast} to ${last}`;
}
