/**
 * CLI exit code constants and the ExitCode type.
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
 *   9 — loop exhausted (LoopMaxIterationsError)
 *  75 — run paused waiting for input
 */

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
  loop_exhausted: 9,
  paused: 75,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];
