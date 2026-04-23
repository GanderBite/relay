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
 *
 * Error format follows the product spec error template:
 *   ✕ <one-line headline>
 *
 *     <one-sentence explanation>
 *
 *     → <exact command or edit to try next>
 */

import {
  type AuthTimeoutError,
  type ClaudeAuthError,
  ERROR_CODES,
  type FlowDefinitionError,
  type HandoffSchemaError,
  NoProviderConfiguredError,
  PipelineError,
  type ProviderAuthError,
  type ProviderCapabilityError,
  type StepFailureError,
  type TimeoutError,
} from '@relay/core';
import { CommanderError } from 'commander';
import { gray, red } from './color.js';
import { fmtDuration } from './format.js';

// ---------------------------------------------------------------------------
// Exit code constants
// ---------------------------------------------------------------------------

export const EXIT_CODES = {
  success: 0,
  runner_failure: 1,
  definition_error: 2,
  auth_error: 3,
  baton_error: 4,
  timeout: 5,
  no_provider: 6,
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
 * Associates a PipelineError subtype (identified by its stable `code` string)
 * with an exit code and a format function.
 */
type ErrorHandler = {
  exitCode: number;
  format: (e: PipelineError) => string;
};

const errorRegistry = new Map<string, ErrorHandler>([
  // StepFailureError — step exited non-zero
  [
    ERROR_CODES.STEP_FAILURE,
    {
      exitCode: EXIT_CODES.runner_failure,
      format(e: PipelineError): string {
        const err = e as StepFailureError;
        // StepFailureDetails does not define `runId`; use guarded string-index access.
        const runId = typeof err.details?.['runId'] === 'string' ? err.details['runId'] : '<runId>';
        return [
          red(`✕ Step '${err.stepId}' failed on attempt ${err.attempt}`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation(`relay logs ${runId} --step ${err.stepId}        see what went wrong`),
          remediation(`relay resume ${runId}                          retry the step`),
        ].join('\n');
      },
    },
  ],

  // FlowDefinitionError — with special handling for cycle detection
  [
    ERROR_CODES.FLOW_DEFINITION,
    {
      exitCode: EXIT_CODES.definition_error,
      format(e: PipelineError): string {
        const err = e as FlowDefinitionError;
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
    },
  ],

  // ProviderCapabilityError — subclass of FlowDefinitionError, same exit code + format
  [
    ERROR_CODES.PROVIDER_CAPABILITY,
    {
      exitCode: EXIT_CODES.definition_error,
      format(e: PipelineError): string {
        const err = e as ProviderCapabilityError;
        return [
          red(`✕ Flow definition error`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('edit flow.ts to fix the definition error'),
          remediation('relay doctor'),
        ].join('\n');
      },
    },
  ],

  // ClaudeAuthError — two distinct shapes
  [
    ERROR_CODES.CLAUDE_AUTH,
    {
      exitCode: EXIT_CODES.auth_error,
      format(e: PipelineError): string {
        const err = e as ClaudeAuthError;
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

        // Shape: ANTHROPIC_API_KEY conflict — the subscription-billing safety guard
        return [
          red('✕ Refusing to run: ANTHROPIC_API_KEY would override your subscription'),
          BLANK,
          `${INDENT}Relay detected ANTHROPIC_API_KEY in your environment. Running now would`,
          `${INDENT}bill your API account instead of your Max subscription — a surprise we`,
          `${INDENT}prevent by default.`,
          BLANK,
          remediation('unset ANTHROPIC_API_KEY    use subscription (recommended)'),
          remediation('relay doctor              full environment check'),
        ].join('\n');
      },
    },
  ],

  // AuthTimeoutError — must be registered before TimeoutError (same exit code, different format)
  [
    ERROR_CODES.AUTH_TIMEOUT,
    {
      exitCode: EXIT_CODES.timeout,
      format(e: PipelineError): string {
        const err = e as AuthTimeoutError;
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
    },
  ],

  // TimeoutError — runner exceeded its timeoutMs budget
  [
    ERROR_CODES.TIMEOUT,
    {
      exitCode: EXIT_CODES.timeout,
      format(e: PipelineError): string {
        const err = e as TimeoutError;
        const stepId = err.stepId;
        const timeoutMs = err.timeoutMs;
        const humanTime = fmtDuration(timeoutMs);

        // TimeoutDetails defines `runId` and `artifactPath` — use typed dot access.
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
    },
  ],

  // HandoffSchemaError
  [
    ERROR_CODES.HANDOFF_SCHEMA,
    {
      exitCode: EXIT_CODES.baton_error,
      format(e: PipelineError): string {
        const err = e as HandoffSchemaError;
        const handoffId = err.handoffId;
        const issueLines = err.issues.map((issue) => {
          const pathStr = issue.path.length > 0 ? issue.path.map(String).join('.') : handoffId;
          return `${INDENT}  ${handoffId}${pathStr !== handoffId ? `[${pathStr}]` : ''} ${issue.message}`;
        });

        // HandoffSchemaDetails defines `runId`, `stepName`, `promptFile` — use typed dot access.
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
    },
  ],

  // NoProviderConfiguredError
  [
    ERROR_CODES.NO_PROVIDER,
    {
      exitCode: EXIT_CODES.no_provider,
      format(_e: PipelineError): string {
        return [
          red('✕ no provider configured'),
          BLANK,
          `${INDENT}Relay does not know which backend to run your flow on.`,
          BLANK,
          remediation('relay init                            pick a provider interactively'),
          remediation(
            'relay run <flow> --provider claude-cli   use the subscription-safe provider',
          ),
        ].join('\n');
      },
    },
  ],

  // ProviderAuthError — generic provider auth misconfiguration
  [
    ERROR_CODES.PROVIDER_AUTH,
    {
      exitCode: EXIT_CODES.auth_error,
      format(e: PipelineError): string {
        const err = e as ProviderAuthError;
        return [
          red(`✕ Authentication failed for provider '${err.providerName}'`),
          BLANK,
          `${INDENT}${err.message}`,
          BLANK,
          remediation('relay doctor'),
        ].join('\n');
      },
    },
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
