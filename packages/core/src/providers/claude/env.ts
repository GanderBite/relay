/**
 * Environment allowlist for ClaudeProvider subprocess invocations.
 *
 * The `claude` binary inherits whatever env the parent process had, which may
 * include `ANTHROPIC_API_KEY`. The claude-agent-sdk merges its `options.env`
 * on top of `process.env` rather than using it as the authoritative spawn env.
 * That means a naive keep-list leaves every unlisted parent var in place — the
 * billing-safety guard in auth.ts would be silently defeated and any secret
 * in the caller's environment would leak to the subprocess.
 *
 * To get true containment we must both:
 *   - include: copy every allowlisted host env var at its real value, and
 *   - suppress: set every non-allowlisted host env var to `undefined`.
 *
 * The SDK documents `undefined` values as the way to remove an inherited var
 * during the merge. The returned object is therefore `Record<string, string
 * | undefined>` — a patch, not a standalone env.
 *
 * The two-phase allowlist (exact names + prefixes) reflects two different
 * requirements:
 *
 *   Exact names: a fixed set of POSIX/system variables the binary needs to
 *   function correctly (path resolution, locale, timezone, temp files, shell).
 *   Prefix sweep: captures every variable in a family (e.g., all CLAUDE_*)
 *   without enumerating them one-by-one — the family can grow without this
 *   file changing.
 *
 * Caller-supplied `extra` values are merged last, so per-step env overrides
 * always win over host env and are never suppressed.
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
   * Keys here take precedence over anything in process.env and are never
   * suppressed.
   */
  extra?: Record<string, string>;
}

/**
 * Build a safe env patch for a ClaudeProvider subprocess invocation.
 *
 * Walks process.env once and for each key either:
 *   - copies the real value (allowlisted via exact match or prefix), or
 *   - emits `undefined` (instructs the SDK merge to strip the inherited var).
 *
 * Caller-supplied extras are merged last and always carry a string value.
 *
 * Never mutates process.env. Always returns a fresh plain object.
 */
export function buildEnvAllowlist(
  opts: BuildEnvAllowlistOptions = {},
): Record<string, string | undefined> {
  const prefixes =
    opts.allowApiKey === true ? ALLOWLIST_PREFIX_WITH_API : ALLOWLIST_PREFIX_BASE;
  const exact = new Set<string>(ALLOWLIST_EXACT);
  const result: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    // Skip keys the host never actually set — there is nothing to suppress
    // and no value to forward.
    if (value === undefined) {
      continue;
    }

    const isExact = exact.has(key);
    const isPrefix = prefixes.some((p) => key.startsWith(p));

    if (isExact || isPrefix) {
      // Include: forward the real host value.
      result[key] = value;
    } else {
      // Suppress: tell the SDK merge to drop this inherited var.
      result[key] = undefined;
    }
  }

  // Merge caller-supplied overrides last. These always win — they represent
  // explicit per-step or per-run env that must reach the subprocess unchanged,
  // even if the same key would otherwise have been suppressed above.
  if (opts.extra !== undefined) {
    for (const [key, value] of Object.entries(opts.extra)) {
      result[key] = value;
    }
  }

  return result;
}
