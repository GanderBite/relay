/**
 * Exit code mapper and error formatter for the Relay CLI.
 *
 * Exit codes follow tech spec §8.2:
 *   0 — success
 *   1 — step failure (StepFailureError, generic Error, unknown)
 *   2 — flow definition error (FlowDefinitionError, ProviderCapabilityError)
 *   3 — auth / environment error (ClaudeAuthError, ProviderAuthError)
 *   4 — handoff / schema error (HandoffSchemaError)
 *   5 — timeout (TimeoutError, AuthTimeoutError)
 *
 * Error format follows product spec §12 template:
 *   ✕ <one-line headline>
 *
 *     <one-sentence explanation>
 *
 *     → <exact command or edit to try next>
 */

import {
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
 * Map any thrown value to a CLI exit code per §8.2.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof StepFailureError) return 1;
  if (err instanceof FlowDefinitionError) return 2;
  if (err instanceof ClaudeAuthError) return 3;
  if (err instanceof ProviderAuthError) return 3;
  if (err instanceof HandoffSchemaError) return 4;
  if (err instanceof TimeoutError) return 5;
  if (err instanceof PipelineError) return 1;
  if (err instanceof Error) return 1;
  return 1;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Two-space indent for body lines (product spec §12.1). */
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
// formatError — product spec §12.2 (verbatim copy)
// ---------------------------------------------------------------------------

/**
 * Produce a fully-formatted multi-line error block for stderr.
 *
 * Output shape (product spec §12.1):
 *   ✕ <headline>          ← red
 *
 *     <explanation>       ← plain, two-space indent
 *
 *     → <command>         ← one per remediation, two-space indent
 *
 * Every shape ends with at least one → line — no dead-ends.
 */
export function formatError(err: unknown): string {
  // ----------------------------------------------------------------
  // ClaudeAuthError — two distinct shapes
  // ----------------------------------------------------------------
  if (err instanceof ClaudeAuthError) {
    const msg = err.message.toLowerCase();

    // Shape: binary missing (product spec §12.2 "Claude CLI missing")
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

    // Shape: ANTHROPIC_API_KEY conflict (product spec §12.2, the big one)
    // This is the default ClaudeAuthError path — key present without opt-in.
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
  // ProviderAuthError — generic provider auth misconfiguration
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

    // Detect cycle: details may carry the path, or the message may name it.
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
  // HandoffSchemaError — product spec §12.2 "Handoff schema mismatch"
  // ----------------------------------------------------------------
  if (err instanceof HandoffSchemaError) {
    const handoffId = err.handoffId;
    const issueLines = err.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : handoffId;
      return `${INDENT}  ${handoffId}${path !== handoffId ? `[${path}]` : ''} ${issue.message}`;
    });

    // Pull runId and stepName from details if available.
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
  // TimeoutError — product spec §12.2 "Timeout"
  // ----------------------------------------------------------------
  if (err instanceof TimeoutError) {
    const stepId = err.stepId;
    const timeoutMs = err.timeoutMs;
    const humanTime = formatMs(timeoutMs);

    // Pull runId and artifact path from details if available.
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
 * Convention: details.cycle may carry the array of step IDs in cycle order,
 * or the message itself may describe a cycle (contains '→' separated names).
 *
 * Returns a formatted string like "inventory → entities → services → inventory"
 * or null if this error does not describe a cycle.
 */
function extractCyclePath(err: FlowDefinitionError): string | null {
  // Check details.cycle — expected shape: string[] of step IDs
  if (
    err.details?.['cycle'] !== undefined &&
    Array.isArray(err.details['cycle']) &&
    err.details['cycle'].length >= 2
  ) {
    const steps = err.details['cycle'] as string[];
    // Close the cycle by appending the first step at the end
    return [...steps, steps[0]].join(' → ');
  }

  // Fall back to message heuristic: if the message contains '→' it's already
  // a formatted cycle string.
  if (err.message.includes('→') && err.message.toLowerCase().includes('cycle')) {
    // Extract the path portion — everything after "cycle:" or similar.
    const match = /cycle[:\s]+(.+)/i.exec(err.message);
    if (match?.[1] !== undefined) return match[1].trim();
  }

  // Message mentions "cycle" without a path — return null so caller falls
  // through to the generic FlowDefinitionError format.
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
