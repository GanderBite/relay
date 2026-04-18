/**
 * Inspects the environment BEFORE any Claude SDK call happens.
 *
 * This module owns Relay's subscription-billing safety contract: a user with a
 * Pro/Max subscription must never have tokens silently routed to a paid API
 * account because `ANTHROPIC_API_KEY` was lying around in their shell. The
 * `claude` binary puts `ANTHROPIC_API_KEY` ahead of subscription credentials
 * in its auth precedence, so we refuse to proceed — returning `err(...)` —
 * before the SDK is given a chance.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { err, ok, type Result } from 'neverthrow';

import { ClaudeAuthError } from '../../errors.js';
import type { AuthState } from '../types.js';

const execFileAsync = promisify(execFile);

/** Short wall-clock limit for `claude --version`. Enough for a cold binary, not so long that a stuck PATH entry stalls the run. */
const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

/** Human-readable remediation for the API-key safety guard. Must render verbatim — no trailing punctuation, no emojis. */
const API_KEY_REMEDIATION =
  'ANTHROPIC_API_KEY is set; relay defaults to subscription billing. Unset it, or call runner.allowApiKey(), or set RELAY_ALLOW_API_KEY=1.';

/** Warning surfaced exactly once per run when the user has opted into API billing with `ANTHROPIC_API_KEY` present. */
const API_ACCOUNT_WARNING = 'billing to API account, not subscription';

/** Returned when the `claude` binary is not on PATH. */
const CLAUDE_MISSING_MESSAGE =
  'claude command not found on PATH. Install it: npm install -g @anthropic-ai/claude-code';

export interface InspectClaudeAuthOptions {
  /** When true, the caller explicitly accepts API-account billing if `ANTHROPIC_API_KEY` is set. */
  allowApiKey?: boolean;
}

/**
 * Inspect auth state and confirm the `claude` binary is callable.
 *
 * Precedence (a match short-circuits the rest):
 *   1. `ANTHROPIC_API_KEY` safety guard — only checked when no explicit cloud
 *      routing env var is set. Cloud routing (bedrock/vertex/foundry) sends
 *      tokens to those accounts instead of the Anthropic API, so the guard
 *      does not apply there.
 *   2. Cloud routing: `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`,
 *      `CLAUDE_CODE_USE_FOUNDRY` / `ANTHROPIC_FOUNDRY_URL`.
 *   3. `CLAUDE_CODE_OAUTH_TOKEN` → explicit subscription (token mode).
 *   4. Interactive subscription fallback — we cannot verify this without
 *      calling the binary, so we trust it and let the first invocation fail
 *      loudly if credentials are missing.
 *
 * Always finishes by spawning `claude --version` to confirm the binary exists.
 *
 * Returns `ok(AuthState)` on success or `err(ClaudeAuthError)` on any failure.
 * Never throws.
 */
export async function inspectClaudeAuth(
  opts: InspectClaudeAuthOptions = {},
): Promise<Result<AuthState, ClaudeAuthError>> {
  const env = process.env;
  const hasApiKey = isNonEmpty(env.ANTHROPIC_API_KEY);
  const envAllowsApiKey = isNonEmpty(env.RELAY_ALLOW_API_KEY);
  const allowApiKey = opts.allowApiKey === true || envAllowsApiKey;

  const useBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const useVertex = env.CLAUDE_CODE_USE_VERTEX === '1';
  const useFoundry =
    env.CLAUDE_CODE_USE_FOUNDRY === '1' || isNonEmpty(env.ANTHROPIC_FOUNDRY_URL);
  const hasCloudRouting = useBedrock || useVertex || useFoundry;

  // (1) Safety guard: block the silent API-billing path before doing anything
  // else that could touch the SDK. Only bypass when the user has explicitly
  // opted in or when a cloud routing variable is present (those take priority
  // over ANTHROPIC_API_KEY in the `claude` binary's own precedence table).
  if (hasApiKey && !allowApiKey && !hasCloudRouting) {
    return err(
      new ClaudeAuthError(API_KEY_REMEDIATION, {
        envObserved: ['ANTHROPIC_API_KEY'],
        billingSource: 'api-account',
      }),
    );
  }

  // Verify the binary exists. Doing this after the guard keeps a
  // misconfigured machine from spawning any subprocess at all.
  const binaryCheck = await ensureClaudeBinary();
  if (binaryCheck.isErr()) {
    return err(binaryCheck.error);
  }

  // (2) Cloud routing wins if present — the token bill goes to the cloud account.
  if (hasCloudRouting) {
    if (useBedrock) {
      return ok({
        ok: true,
        billingSource: 'bedrock',
        detail: 'routing via AWS Bedrock (CLAUDE_CODE_USE_BEDROCK=1)',
      });
    }
    if (useVertex) {
      return ok({
        ok: true,
        billingSource: 'vertex',
        detail: 'routing via Google Vertex (CLAUDE_CODE_USE_VERTEX=1)',
      });
    }
    // Foundry is the remaining branch.
    return ok({
      ok: true,
      billingSource: 'foundry',
      detail: isNonEmpty(env.ANTHROPIC_FOUNDRY_URL)
        ? 'routing via Azure Foundry (ANTHROPIC_FOUNDRY_URL set)'
        : 'routing via Azure Foundry (CLAUDE_CODE_USE_FOUNDRY=1)',
    });
  }

  // (3) Explicit API-account opt-in. `ANTHROPIC_API_KEY` is set and the user
  // has accepted the billing consequences — surface a warning so they never
  // forget which account is being charged.
  if (hasApiKey && allowApiKey) {
    return ok({
      ok: true,
      billingSource: 'api-account',
      detail: envAllowsApiKey
        ? 'API account (RELAY_ALLOW_API_KEY=1)'
        : 'API account (runner.allowApiKey())',
      warnings: [API_ACCOUNT_WARNING],
    });
  }

  // (4) OAuth token present → subscription billing via long-lived token.
  if (isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN)) {
    return ok({
      ok: true,
      billingSource: 'subscription',
      detail: 'subscription (CLAUDE_CODE_OAUTH_TOKEN)',
    });
  }

  // (5) Interactive subscription fallback. We cannot confirm `~/.claude/credentials`
  // without running the binary, so we assume it and let the first real call
  // surface any auth failure.
  return ok({
    ok: true,
    billingSource: 'subscription',
    detail: 'subscription (interactive credentials)',
  });
}

/**
 * Env keys forwarded to the `claude --version` preflight probe. Mirrors the
 * vars that `buildEnvAllowlist` always includes. PATH/Path covers both POSIX
 * and Windows binary resolution; HOME/USERPROFILE covers user-config lookup on
 * both platforms; the rest prevent locale and temp-dir surprises.
 */
const PREFLIGHT_ENV_KEYS = [
  'PATH', 'Path', 'HOME', 'USERPROFILE', 'USER', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'SHELL',
] as const;

function preflightEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of PREFLIGHT_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/**
 * Spawn `claude --version` with a short timeout. Returns `ok(void)` on a clean
 * exit, `err(ClaudeAuthError)` with install instructions on any failure —
 * missing binary, non-zero exit, timeout, or permission error.
 */
async function ensureClaudeBinary(): Promise<Result<void, ClaudeAuthError>> {
  try {
    await execFileAsync('claude', ['--version'], {
      timeout: CLAUDE_VERSION_TIMEOUT_MS,
      env: preflightEnv(),
    });
    return ok(undefined);
  } catch (e) {
    return err(
      new ClaudeAuthError(CLAUDE_MISSING_MESSAGE, {
        cause: describeSpawnError(e),
      }),
    );
  }
}

function isNonEmpty(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

function describeSpawnError(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}
