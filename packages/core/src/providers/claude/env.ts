/**
 * Environment allowlist for ClaudeProvider subprocess invocations.
 *
 * The `claude` binary inherits whatever env the parent process had, which may
 * include `ANTHROPIC_API_KEY`. Passing raw `process.env` to the subprocess
 * would defeat the billing-safety guard in auth.ts — the key would reach the
 * SDK even after we verified the user opted in, and any future call that
 * skipped the guard would silently bill the API account.
 *
 * The two-phase design (exact names + prefixes) reflects two different
 * requirements:
 *
 *   Exact names: a fixed set of POSIX/system variables the binary needs to
 *   function correctly (path resolution, locale, timezone, temp files, shell).
 *   Prefix sweep: captures every variable in a family (e.g., all CLAUDE_*)
 *   without enumerating them one-by-one — the family can grow without this
 *   file changing.
 *
 * Everything else is dropped. Caller-supplied `extra` values are merged last
 * so per-step env overrides always win over host env.
 */

// ---------------------------------------------------------------------------
// Allowlist constants (exported for tests to assert the contract)
// ---------------------------------------------------------------------------

/**
 * Exact-match env var names always forwarded to the subprocess.
 * These are the minimum POSIX/system variables the `claude` binary needs.
 */
export const ALLOWLIST_EXACT: readonly string[] = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
] as const;

/**
 * Prefix list forwarded when API-key opt-in is NOT active.
 * Captures the entire CLAUDE_ family (CLAUDE_CODE_OAUTH_TOKEN,
 * CLAUDE_CODE_USE_BEDROCK, CLAUDE_CODE_USE_VERTEX, CLAUDE_CODE_USE_FOUNDRY,
 * and any future CLAUDE_* variables the SDK adds).
 */
export const ALLOWLIST_PREFIX_BASE: readonly string[] = ['CLAUDE_'] as const;

/**
 * Prefix list forwarded when `allowApiKey` is true.
 * Extends the base list with ANTHROPIC_*, which covers ANTHROPIC_API_KEY,
 * ANTHROPIC_BASE_URL, ANTHROPIC_FOUNDRY_URL, and any future ANTHROPIC_* vars.
 */
export const ALLOWLIST_PREFIX_WITH_API: readonly string[] = [
  ...ALLOWLIST_PREFIX_BASE,
  'ANTHROPIC_',
] as const;

// ---------------------------------------------------------------------------
// buildEnvAllowlist
// ---------------------------------------------------------------------------

export interface BuildEnvAllowlistOptions {
  /**
   * When true, ANTHROPIC_* variables (including ANTHROPIC_API_KEY) are
   * forwarded to the subprocess. Must only be set when the user has
   * explicitly opted into API-account billing.
   */
  allowApiKey?: boolean;

  /**
   * Per-step or per-run env overrides merged on top of the filtered host env.
   * Keys here take precedence over anything in process.env.
   */
  extra?: Record<string, string>;
}

/**
 * Build a safe env object for a ClaudeProvider subprocess invocation.
 *
 * Iterates process.env once, copying only keys that pass the two-phase filter:
 *   1. Exact match against ALLOWLIST_EXACT.
 *   2. Prefix match against the active prefix list.
 *
 * Undefined values (which Node can produce for env vars set without a value on
 * some platforms) are silently dropped — the subprocess always receives strings.
 *
 * Never mutates process.env. Always returns a fresh plain object.
 */
export function buildEnvAllowlist(opts: BuildEnvAllowlistOptions = {}): Record<string, string> {
  const prefixes = opts.allowApiKey === true ? ALLOWLIST_PREFIX_WITH_API : ALLOWLIST_PREFIX_BASE;

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    // Drop undefined values — they cannot be safely passed as env strings.
    if (value === undefined) {
      continue;
    }

    // Phase 1: exact-name match.
    if ((ALLOWLIST_EXACT as readonly string[]).includes(key)) {
      result[key] = value;
      continue;
    }

    // Phase 2: prefix match against the active prefix list.
    for (const prefix of prefixes) {
      if (key.startsWith(prefix)) {
        result[key] = value;
        break;
      }
    }
  }

  // Merge caller-supplied overrides last. These always win — they represent
  // explicit per-step or per-run env that must reach the subprocess unchanged.
  if (opts.extra !== undefined) {
    for (const [key, value] of Object.entries(opts.extra)) {
      result[key] = value;
    }
  }

  return result;
}
