/**
 * Exit code mapper and error formatter for the Relay CLI.
 *
 * Exit codes:
 *   0 — success
 *   1 — step failure (StepFailureError, generic Error, unknown)
 *   2 — flow definition error (FlowDefinitionError, ProviderCapabilityError)
 *   3 — subscription auth / billing safety guard (ClaudeAuthError)
 *   4 — handoff / schema error (HandoffSchemaError)
 *   5 — timeout (TimeoutError, AuthTimeoutError)
 *   6 — provider auth error (ProviderAuthError)
 *
 * Error format follows the product spec error template:
 *   ✕ <one-line headline>
 *
 *     <one-sentence explanation>
 *
 *     → <exact command or edit to try next>
 */

import { CommanderError } from 'commander';
import {
  AuthTimeoutError,
  ClaudeAuthError,
  FlowDefinitionError,
  HandoffSchemaError,
  PipelineError,
  ProviderAuthError,
  StepFailureError,
  TimeoutError,
} from '@relay/core';
import { red, gray } from './visual.js';

// ---------------------------------------------------------------------------
// Exit code mapper
// ---------------------------------------------------------------------------

/**
 * Map any thrown value to a CLI exit code.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof StepFailureError) return 1;
  if (err instanceof FlowDefinitionError) return 2;
  if (err instanceof ClaudeAuthError) return 3;
  if (err instanceof AuthTimeoutError) return 5;
  if (err instanceof TimeoutError) return 5;
  if (err instanceof HandoffSchemaError) return 4;
  if (err instanceof ProviderAuthError) return 6;
  if (err instanceof PipelineError) return 1;
  if (err instanceof CommanderError) return err.exitCode;
  if (err instanceof Error) return 1;
  return 1;
}

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

/**
 * Format a millisecond duration as a human-readable string.
 * Uses exact values — no rounding for vibes.
 */
function formatMs(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds}s`;
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
  // ClaudeAuthError — two distinct shapes
  // ----------------------------------------------------------------
  if (err instanceof ClaudeAuthError) {
    const msg = err.message.toLowerCase();

    // Shape: binary missing
    if (msg.includes('binary missing') || msg.includes('not found') || msg.includes('not installed')) {
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
      remediation('unset ANTHROPIC_API_KEY                 use subscription (recommended)'),
      remediation('relay run codebase-discovery . --api-key  explicitly use API billing'),
      remediation('relay doctor                             full environment check'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // AuthTimeoutError — must come before TimeoutError (subclass)
  // ----------------------------------------------------------------
  if (err instanceof AuthTimeoutError) {
    const humanTime = formatMs(err.timeoutMs);
    return [
      red(`✕ Authentication for provider '${err.providerName}' timed out after ${humanTime}`),
      BLANK,
      `${INDENT}The provider's authentication did not complete within the configured timeout.`,
      `${INDENT}This usually means a misconfigured CLI probe or a network connectivity issue.`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // TimeoutError — step exceeded its timeoutMs budget
  // ----------------------------------------------------------------
  if (err instanceof TimeoutError) {
    const stepId = err.stepId;
    const timeoutMs = err.timeoutMs;
    const humanTime = formatMs(timeoutMs);

    const runId = typeof err.details?.['runId'] === 'string' ? err.details['runId'] : '<runId>';
    const artifactPath =
      typeof err.details?.['artifactPath'] === 'string'
        ? err.details['artifactPath']
        : `./.relay/runs/${runId}/artifacts/${stepId}.partial`;

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
  }

  // ----------------------------------------------------------------
  // ProviderAuthError — generic provider auth misconfiguration (exit 6)
  // ----------------------------------------------------------------
  if (err instanceof ProviderAuthError) {
    return [
      red(`✕ Authentication failed for provider '${err.providerName}'`),
      BLANK,
      `${INDENT}${err.message}`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // FlowDefinitionError — with special handling for cycle detection
  // ----------------------------------------------------------------
  if (err instanceof FlowDefinitionError) {
    const msg = err.message;

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
      `${INDENT}${msg}`,
      BLANK,
      remediation('edit flow.ts to fix the definition error'),
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // HandoffSchemaError
  // ----------------------------------------------------------------
  if (err instanceof HandoffSchemaError) {
    const handoffId = err.handoffId;
    const issueLines = err.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : handoffId;
      return `${INDENT}  ${handoffId}${path !== handoffId ? `[${path}]` : ''} ${issue.message}`;
    });

    const runId = typeof err.details?.['runId'] === 'string' ? err.details['runId'] : '<runId>';
    const stepName = typeof err.details?.['stepName'] === 'string' ? err.details['stepName'] : handoffId;
    const promptFile =
      typeof err.details?.['promptFile'] === 'string'
        ? err.details['promptFile']
        : `prompts/${stepName}.md`;

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
  }

  // ----------------------------------------------------------------
  // StepFailureError — step exited non-zero
  // ----------------------------------------------------------------
  if (err instanceof StepFailureError) {
    const runId = typeof err.details?.['runId'] === 'string' ? err.details['runId'] : '<runId>';

    return [
      red(`✕ Step '${err.stepId}' failed on attempt ${err.attempt}`),
      BLANK,
      `${INDENT}${err.message}`,
      BLANK,
      remediation(`relay logs ${runId} --step ${err.stepId}        see what went wrong`),
      remediation(`relay resume ${runId}                            retry the step`),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // Generic PipelineError
  // ----------------------------------------------------------------
  if (err instanceof PipelineError) {
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
 * Checks details.cycle (expected shape: string[] of step IDs).
 * Falls back to a message heuristic for errors that already carry a
 * formatted cycle description containing '→'.
 *
 * Returns a formatted string like "inventory → entities → services → inventory"
 * or null if this error does not describe a cycle.
 */
function extractCyclePath(err: FlowDefinitionError): string | null {
  if (
    err.details?.['cycle'] !== undefined &&
    Array.isArray(err.details['cycle']) &&
    err.details['cycle'].length >= 2
  ) {
    const steps = err.details['cycle'] as string[];
    return [...steps, steps[0]].join(' → ');
  }

  if (err.message.includes('→') && err.message.toLowerCase().includes('cycle')) {
    const match = /cycle[:\s]+(.+)/i.exec(err.message);
    if (match?.[1] !== undefined) return match[1].trim();
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
