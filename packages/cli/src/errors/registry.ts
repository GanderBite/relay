/**
 * Per-error-class handler registry and the makeHandler factory.
 *
 * Each entry maps an ERROR_CODES string key to an exit code and a formatted
 * multi-line error block. makeHandler wraps the typed format callback with an
 * instanceof guard so the callback receives a narrowed type without any `as`
 * cast.
 */

import {
  AuthTimeoutError,
  ClaudeAuthError,
  ERROR_CODES,
  FlowDefinitionError,
  FlowImportError,
  HandoffSchemaError,
  LoopMaxIterationsError,
  type PipelineError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '@ganderbite/relay-core';
import { gray, red } from '../color.js';
import { FlowLoadError } from '../flow-loader.js';
import { fmtDuration } from '../format.js';
import { EXIT_CODES } from './codes.js';
import { BLANK, INDENT, remediation } from './helpers.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Public handler shape — generic over the specific PipelineError subclass it formats. */
export type ErrorHandler<T extends PipelineError> = {
  exitCode: number;
  format: (e: T) => string;
};

/** Internal storage shape with the generic parameter erased. */
export type RegistryEntry = {
  exitCode: number;
  format: (e: PipelineError) => string;
};

// ---------------------------------------------------------------------------
// makeHandler
// ---------------------------------------------------------------------------

/**
 * Build a registry entry from an `ErrorHandler<T>`. Runs an instanceof guard
 * before invoking the typed callback; emits a minimal fallback on mismatch.
 */
export function makeHandler<T extends PipelineError>(
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

// ---------------------------------------------------------------------------
// Internal helpers for FlowDefinitionError cycle extraction
// ---------------------------------------------------------------------------

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

function lastEdge(cyclePath: string): string {
  const parts = cyclePath.split(' → ').map((s) => s.trim());
  if (parts.length < 2) return cyclePath;
  const last = parts[parts.length - 1] ?? '';
  const secondLast = parts[parts.length - 2] ?? '';
  return `${secondLast} to ${last}`;
}

// ---------------------------------------------------------------------------
// ERROR_CODES mapping reference
//
// The table below lists every relay_* code from @ganderbite/relay-core's
// ERROR_CODES and records whether it is handled here (with the resulting exit
// code) or will fall through to the exitCodeFor fallback (exit 1).
//
//   relay_ATOMIC_WRITE            — unmapped  → exit 1 (runner_failure)
//   relay_AUTH_TIMEOUT            — mapped    → exit 5 (timeout)
//   relay_CLAUDE_AUTH             — mapped    → exit 3 (auth_error)
//   relay_FLOW_DEFINITION         — mapped    → exit 2 (definition_error)
//   relay_FLOW_IMPORT             — mapped    → exit 2 (definition_error)
//   relay_FLOW_INVALID            — mapped    → exit 2 (definition_error)
//   relay_FLOW_NOT_FOUND          — mapped    → exit 1 (runner_failure)
//   relay_HANDOFF_IO              — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_NOT_FOUND       — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_OUTPUT          — unmapped  → exit 1 (runner_failure)
//   relay_HANDOFF_SCHEMA          — mapped    → exit 4 (handoff_error)
//   relay_HANDOFF_WRITE           — unmapped  → exit 1 (runner_failure)
//   relay_METRICS_WRITE           — unmapped  → exit 1 (runner_failure)
//   relay_NO_PROVIDER             — mapped    → exit 6 (no_provider)
//   relay_PROVIDER_AUTH           — mapped    → exit 3 (auth_error)
//   relay_PROVIDER_CAPABILITY     — mapped    → exit 2 (definition_error)
//   relay_PROVIDER_RATE_LIMIT     — mapped    → exit 8 (rate_limit)
//   relay_STATE_CORRUPT           — unmapped  → exit 1 (runner_failure)
//   relay_STATE_NOT_FOUND         — unmapped  → exit 1 (runner_failure)
//   relay_STATE_TRANSITION        — unmapped  → exit 1 (runner_failure)
//   relay_STATE_VERSION_MISMATCH  — unmapped  → exit 1 (runner_failure)
//   relay_STATE_WRITE             — unmapped  → exit 1 (runner_failure)
//   relay_STEP_FAILURE            — mapped    → exit 1 (runner_failure)
//   relay_TIMEOUT                 — mapped    → exit 5 (timeout)
//   relay_LOOP_MAX_ITERATIONS_EXCEEDED — mapped → exit 9 (loop_exhausted)
//   relay_flow_import_error       — mapped    → exit 2 (definition_error) [alias for FLOW_IMPORT]
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const errorRegistry = new Map<string, RegistryEntry>([
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
      (err) =>
        [
          red(`✕ Flow definition error`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('edit flow.ts to fix the definition error'),
          remediation('relay doctor'),
        ].join('\n'),
    ),
  ],

  // FlowImportError — missing-file, missing-default-export, or build-not-run
  [
    ERROR_CODES.FLOW_IMPORT,
    makeHandler(
      EXIT_CODES.definition_error,
      (e): e is FlowImportError => e instanceof FlowImportError,
      (err) => {
        const path = err.details?.path ?? '<unknown>';
        const reason = err.details?.reason;

        if (reason === 'build-not-run') {
          return [
            red('✕ Flow module not found — build has not been run'),
            BLANK,
            `${INDENT}${err.message}`,
            BLANK,
            remediation(`pnpm build    run in the flow package directory to compile it`),
            remediation(`relay doctor  full environment check`),
          ].join('\n');
        }

        if (reason === 'missing-default-export') {
          return [
            red('✕ Flow module has no default export'),
            BLANK,
            `${INDENT}${path} does not export a valid Flow as its default export.`,
            BLANK,
            remediation(
              `edit flow.ts and add: export default defineFlow(...)   or   export { flow as default }`,
            ),
            remediation(`pnpm build    rebuild after editing`),
          ].join('\n');
        }

        // missing-file (and unknown reasons)
        return [
          red('✕ Flow file not found'),
          BLANK,
          `${INDENT}${path} does not exist.`,
          BLANK,
          remediation(`relay run <path-to-flow>    specify the correct path`),
          remediation(`relay doctor                full environment check`),
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

  // NoProviderConfiguredError — no typed fields accessed; plain RegistryEntry shape
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
      (err) =>
        [
          red(`✕ Authentication failed for provider '${err.providerName}'`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('relay doctor'),
        ].join('\n'),
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

  // LoopMaxIterationsError — loop step exhausted its iteration cap
  [
    ERROR_CODES.LOOP_MAX_ITERATIONS,
    makeHandler(
      EXIT_CODES.loop_exhausted,
      (e): e is LoopMaxIterationsError => e instanceof LoopMaxIterationsError,
      (err) => {
        const loopStepId = err.loopStepId;
        const iterationsRun = err.iterationsRun;
        const maxIterations = err.maxIterations;
        const handoffsDir = err.details?.handoffsDir ?? './.relay/runs/<runId>/handoffs';
        return [
          red(`✕ Loop step '${loopStepId}' exhausted its iteration cap`),
          BLANK,
          `${INDENT}The loop ran ${iterationsRun} of ${maxIterations} permitted iterations without`,
          `${INDENT}the exit condition being satisfied.`,
          BLANK,
          remediation(`inspect handoffs: ${handoffsDir}`),
          remediation(`raise maxIterations in flow.ts or tighten the until condition`),
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
