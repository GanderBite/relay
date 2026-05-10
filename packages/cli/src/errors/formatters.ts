/**
 * Per-error-class format functions for the error registry.
 *
 * Each exported function accepts a narrowed error subclass and returns the
 * formatted multi-line string that the CLI prints to stderr.
 */

import type {
  AuthTimeoutError,
  ClaudeAuthError,
  FlowDefinitionError,
  FlowImportError,
  HandoffSchemaError,
  LoopMaxIterationsError,
  ProviderAuthError,
  ProviderCapabilityError,
  ProviderRateLimitError,
  StepFailureError,
  TimeoutError,
} from '@ganderbite/relay-core';
import { red } from '../color.js';
import type { FlowLoadError } from '../flow-loader.js';
import { fmtDuration } from '../format.js';
import { BLANK, INDENT, remediation } from './helpers.js';

// ---------------------------------------------------------------------------
// FlowDefinitionError helpers
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
// Formatters
// ---------------------------------------------------------------------------

export function formatStepFailure(err: StepFailureError): string {
  const runId = err.details?.runId ?? '<runId>';
  return [
    red(`✕ Step '${err.stepId}' failed on attempt ${err.attempt}`),
    BLANK,
    `${INDENT}${err.message}`,
    BLANK,
    remediation(`relay logs ${runId} --step ${err.stepId}        see what went wrong`),
    remediation(`relay resume ${runId}                          retry the step`),
  ].join('\n');
}

export function formatFlowDefinition(err: FlowDefinitionError): string {
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
}

export function formatProviderCapability(err: ProviderCapabilityError): string {
  return [
    red(`✕ Flow definition error`),
    BLANK,
    `${INDENT}${err.message}`,
    BLANK,
    remediation('edit flow.ts to fix the definition error'),
    remediation('relay doctor'),
  ].join('\n');
}

export function formatFlowImport(err: FlowImportError): string {
  const path = err.details?.path ?? '<unknown>';
  const reason = err.details?.reason;

  if (reason === 'absent') {
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

  // unparseable (and unknown reasons) — file exists but could not be loaded
  return [
    red('✕ Flow module could not be loaded'),
    BLANK,
    `${INDENT}${path} exists but failed to import.`,
    BLANK,
    remediation(`check the flow package for syntax errors or missing dependencies`),
    remediation(`relay doctor                full environment check`),
  ].join('\n');
}

export function formatClaudeAuth(err: ClaudeAuthError): string {
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
}

export function formatAuthTimeout(err: AuthTimeoutError): string {
  const humanTime = fmtDuration(err.timeoutMs);
  return [
    red(`✕ Authentication for provider '${err.providerName}' timed out after ${humanTime}`),
    BLANK,
    `${INDENT}The provider's authentication did not complete within the configured timeout.`,
    `${INDENT}This usually means a misconfigured CLI probe or a network connectivity issue.`,
    BLANK,
    remediation('relay doctor'),
  ].join('\n');
}

export function formatTimeout(err: TimeoutError): string {
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
}

export function formatHandoffSchema(err: HandoffSchemaError): string {
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
}

export function formatProviderAuth(err: ProviderAuthError): string {
  return [
    red(`✕ Authentication failed for provider '${err.providerName}'`),
    BLANK,
    `${INDENT}${err.message}`,
    BLANK,
    remediation('relay doctor'),
  ].join('\n');
}

export function formatProviderRateLimit(err: ProviderRateLimitError): string {
  const runId = err.details?.runId ?? '<runId>';
  return [
    red(`✕ Rate limited by provider '${err.providerName}'`),
    BLANK,
    `${INDENT}The provider returned a rate-limit response on step '${err.stepId}' (attempt ${err.attempt}).`,
    `${INDENT}Wait for the rate limit to reset, then resume the run.`,
    BLANK,
    remediation(`relay resume ${runId}      retry after the rate limit resets`),
  ].join('\n');
}

export function formatLoopMaxIterations(err: LoopMaxIterationsError): string {
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
}

export function formatFlowNotFound(err: FlowLoadError): string {
  return [
    red('✕ Flow not found'),
    BLANK,
    `${INDENT}${err.message}`,
    BLANK,
    remediation('relay run <path-to-flow>    specify the correct path'),
  ].join('\n');
}

export function formatFlowInvalid(err: FlowLoadError): string {
  return [
    red('✕ Flow package is invalid'),
    BLANK,
    `${INDENT}${err.message}`,
    BLANK,
    remediation('relay doctor    check your environment'),
  ].join('\n');
}
