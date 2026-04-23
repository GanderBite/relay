/**
 * Environment allowlist for the claude-cli provider.
 *
 * The claude-cli provider spawns the `claude` binary directly via `claude -p`.
 * The binary inherits the parent process env unless we replace it. A naive
 * keep-list would leave every unlisted parent var in place — secrets included.
 *
 * To get true containment we must both:
 *   - include: copy every allowlisted host env var at its real value, and
 *   - suppress: set every non-allowlisted host env var to `undefined`.
 *
 * The subprocess step documents `undefined` values as the way to remove an
 * inherited var during the merge. The returned object is therefore
 * `Record<string, string | undefined>` — a patch, not a standalone env.
 *
 * TOS surface:
 *
 *   claude-cli → forwards `CLAUDE_*` (so the binary sees the OAuth token and
 *     subscription credentials), and EXPLICITLY suppresses `ANTHROPIC_API_KEY`
 *     even if the host has it set. The API key must never reach this
 *     subprocess — the user picked the subscription path.
 *
 * Cloud-routing exact keys (`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`,
 * `ANTHROPIC_FOUNDRY_URL`) are forwarded because they pre-empt either token
 * at runtime and route tokens to a cloud account.
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
 * Cloud-routing exact-match keys. The presence of any one of these tells the
 * binary to bill the cloud account instead of the Anthropic subscription.
 */
export const ALLOWLIST_CLOUD_ROUTING: readonly string[] = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'ANTHROPIC_FOUNDRY_URL',
] as const;

/**
 * Prefix list forwarded under the claude-cli provider.
 * Captures CLAUDE_CODE_OAUTH_TOKEN and any future CLAUDE_* vars.
 * ANTHROPIC_API_KEY is explicitly suppressed below.
 */
export const ALLOWLIST_PREFIX_CLI: readonly string[] = ['CLAUDE_'] as const;

/**
 * Keys explicitly suppressed (mapped to `undefined`) under the claude-cli
 * provider, even if they would otherwise be matched by a prefix or are
 * present in the host env. These are the TOS-leak surfaces.
 */
const SUPPRESS_CLI: readonly string[] = ['ANTHROPIC_API_KEY'] as const;

// ---------------------------------------------------------------------------
// buildEnvAllowlist
// ---------------------------------------------------------------------------

export interface BuildEnvAllowlistOptions {
  /**
   * Per-step or per-run env overrides merged on top of the filtered host env.
   * Keys here take precedence over anything in process.env and over the
   * forced suppression list.
   */
  extra?: Record<string, string>;
}

/**
 * Build a safe env patch for the claude-cli subprocess.
 *
 * Walks process.env once and for each key either:
 *   - copies the real value (allowlisted via exact match or prefix), or
 *   - emits `undefined` (instructs the subprocess step to strip the
 *     inherited var).
 *
 * Always-suppressed keys are then force-set to `undefined` regardless of
 * whether the host had them, so the patch is complete on its own and
 * downstream code does not have to introspect process.env to decide what is
 * safe.
 *
 * Caller-supplied extras are merged last and always carry a string value.
 *
 * Never mutates process.env. Always returns a fresh plain object.
 */
export function buildEnvAllowlist(
  opts: BuildEnvAllowlistOptions = {},
): Record<string, string | undefined> {
  const prefixes = ALLOWLIST_PREFIX_CLI;
  const suppress = SUPPRESS_CLI;
  const exact = new Set<string>([...ALLOWLIST_EXACT, ...ALLOWLIST_CLOUD_ROUTING]);
  const suppressSet = new Set<string>(suppress);
  const result: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    // Skip keys the host never actually set — there is nothing to suppress
    // and no value to forward.
    if (value === undefined) {
      continue;
    }

    // Force-suppress wins over any allowlist match for this provider.
    if (suppressSet.has(key)) {
      result[key] = undefined;
      continue;
    }

    const isExact = exact.has(key);
    const isPrefix = prefixes.some((p) => key.startsWith(p));

    if (isExact || isPrefix) {
      // Include: forward the real host value.
      result[key] = value;
    } else {
      // Suppress: tell the subprocess step to drop this inherited var.
      result[key] = undefined;
    }
  }

  // Make the suppression patch complete: even if the host did not have the
  // key set, emit the undefined sentinel so downstream code reading the
  // returned object does not have to know which keys could leak.
  for (const key of suppressSet) {
    if (!(key in result)) {
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
