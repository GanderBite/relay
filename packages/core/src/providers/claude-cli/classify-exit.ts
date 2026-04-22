/**
 * Exit-code classifier for the claude-cli provider.
 *
 * Maps a process exit code and stderr text to a typed PipelineError.
 * String-based stderr matching is inherently brittle; the long-term fix is
 * structured CLI error codes from the claude binary itself.
 */

import { GITHUB_ISSUES_URL } from '../../constants.js';
import {
  type PipelineError,
  ProviderRateLimitError,
  ProviderAuthError,
  StepFailureError,
  TimeoutError,
} from '../../errors.js';

const RATE_LIMIT_RE = /rate[\s-]?limit|HTTP 429|status 429|429 Too Many/i;
const TIMEOUT_RE = /timeout|ETIMEDOUT|ESOCKETTIMEDOUT|deadline exceeded/i;
const AUTH_RE = /authentication|unauthorized|HTTP 401|invalid api key|invalid token|session expired/i;

export interface ClassifyExitArgs {
  exitCode: number | null;
  stderr: string;
  aborted: boolean;
  stepId: string;
  attempt: number;
  providerName: string;
}

/**
 * Classify a claude-cli process exit into a typed PipelineError, or return
 * null when the exit is clean (exitCode === 0 and not aborted) or when the
 * invocation was intentionally aborted (the caller handles abort separately).
 *
 * Priority order for stderr matching:
 *   1. Rate limit  → ProviderRateLimitError
 *   2. Timeout     → TimeoutError
 *   3. Auth        → ProviderAuthError
 *   4. Other       → StepFailureError
 */
export function classifyExit(args: ClassifyExitArgs): PipelineError | null {
  const { exitCode, stderr, aborted, stepId, attempt, providerName } = args;

  if (aborted) {
    return null;
  }

  if (exitCode === 0) {
    return null;
  }

  if (RATE_LIMIT_RE.test(stderr)) {
    return new ProviderRateLimitError(
      `claude -p rate limit: ${stderr.slice(0, 400)}`,
      providerName,
      stepId,
      attempt,
      undefined,
    );
  }

  if (TIMEOUT_RE.test(stderr)) {
    return new TimeoutError(
      `claude -p timeout: ${stderr.slice(0, 400)}`,
      stepId,
      0,
      { providerName, attempt },
    );
  }

  if (AUTH_RE.test(stderr)) {
    return new ProviderAuthError(
      `claude -p auth error: ${stderr.slice(0, 400)}`,
      providerName,
      { stepId, attempt },
    );
  }

  const code = exitCode === null ? 'null' : String(exitCode);
  return new StepFailureError(
    `claude -p exit ${code}: ${stderr.slice(0, 400)}`,
    stepId,
    attempt,
    {
      errorCode: 'E_CLAUDE_CLI_FAIL',
      providerName,
      reportUrl: GITHUB_ISSUES_URL,
    },
  );
}
