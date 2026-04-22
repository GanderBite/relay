/**
 * Auth inspection for the claude-cli provider — runs BEFORE any `claude -p`
 * subprocess and decides whether the run may proceed.
 *
 * The claude-cli provider spawns the `claude` binary, which uses the user's
 * stored subscription credentials. An `ANTHROPIC_API_KEY` in the host env
 * would silently route tokens through the API, which is the inverse of what
 * the user asked for when they picked this provider; the case is flagged as
 * an auth error so the user does not assume the key is in use.
 *
 * Cloud routing (Bedrock/Vertex/Foundry) bypasses the subscription check —
 * those tokens bill to the cloud account, not to Anthropic.
 *
 * Returns `Result<AuthState, ClaudeAuthError>`. Never throws.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { err, ok, type Result } from 'neverthrow';

import { ClaudeAuthError } from '../../errors.js';
import type { AuthState } from '../types.js';

const execFileAsync = promisify(execFile);

/** Short wall-clock limit for `claude --version`. Enough for a cold binary, not so long that a stuck PATH entry stalls the run. */
const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

/** Returned when the `claude` binary is not on PATH. */
const CLAUDE_MISSING_MESSAGE =
  'claude command not found on PATH. Install it: npm install -g @anthropic-ai/claude-code';

/** Remediation when the CLI provider has no detectable subscription credentials. */
const CLI_REQUIRES_SUBSCRIPTION =
  'claude-cli requires subscription auth. Run `claude /login`, or run `relay init` and choose claude-agent-sdk.';

/** Remediation when the CLI provider has no subscription credentials but ANTHROPIC_API_KEY is set — steer the user away from assuming the key will be used. */
const CLI_API_KEY_NOT_USABLE =
  'ANTHROPIC_API_KEY is set but claude-cli cannot use it — the subscription path requires `claude /login` first. Alternatively, run `relay init` and choose claude-agent-sdk.';

/** Provider identifiers accepted by `inspectClaudeAuth`. */
export type ClaudeProviderKind = 'claude-cli';

export interface InspectClaudeAuthOptions {
  /** Which Claude-backed provider is asking. Reserved for future providers; currently only `'claude-cli'` is accepted. */
  providerKind: ClaudeProviderKind;
}

/**
 * Inspect the host env and return the billing surface the claude-cli provider
 * would use, or an error explaining why the run cannot proceed.
 *
 * Precedence (a match short-circuits the rest):
 *
 *   Cloud routing wins for all providers:
 *     CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
 *     CLAUDE_CODE_USE_FOUNDRY / ANTHROPIC_FOUNDRY_URL
 *
 *   claude-cli:
 *     1. CLAUDE_CODE_OAUTH_TOKEN set → ok(subscription, token mode).
 *     2. ~/.claude/.credentials.json present → ok(subscription, interactive).
 *     3. ANTHROPIC_API_KEY set with no subscription signals → err(key set but
 *        not usable on this path).
 *     4. Otherwise → err(missing subscription).
 *
 * After deciding, spawns `claude --version` to confirm the binary exists.
 * The probe runs after the policy check so a misconfigured machine never
 * reaches a subprocess at all.
 */
export async function inspectClaudeAuth(
  opts: InspectClaudeAuthOptions,
): Promise<Result<AuthState, ClaudeAuthError>> {
  const env = process.env;
  const hasApiKey = isNonEmpty(env.ANTHROPIC_API_KEY);
  const hasOauth = isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);

  const useBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const useVertex = env.CLAUDE_CODE_USE_VERTEX === '1';
  const useFoundry = env.CLAUDE_CODE_USE_FOUNDRY === '1' || isNonEmpty(env.ANTHROPIC_FOUNDRY_URL);
  const hasCloudRouting = useBedrock || useVertex || useFoundry;

  // Cloud routing is acceptable; tokens bill to the cloud account and the
  // subscription contract does not apply. Decide before the CLI-specific
  // branch so a stray ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN does not
  // block a legitimate cloud-routed run.
  if (hasCloudRouting) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok(
      cloudRoutingAuthState({ useBedrock, useVertex, foundryUrl: env.ANTHROPIC_FOUNDRY_URL }),
    );
  }

  // providerKind is currently restricted to 'claude-cli' by the type union;
  // the opts argument is kept for forward-compat with future provider kinds.
  void opts;
  return inspectCli({ hasApiKey, hasOauth });
}

async function inspectCli(args: {
  hasApiKey: boolean;
  hasOauth: boolean;
}): Promise<Result<AuthState, ClaudeAuthError>> {
  // (1) Authoritative env signal — the OAuth token tells the binary which
  // subscription account to bill against, so accept it without a filesystem
  // probe.
  if (args.hasOauth) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok({
      ok: true,
      billingSource: 'subscription',
      detail: 'subscription (CLAUDE_CODE_OAUTH_TOKEN)',
    });
  }

  // (2) Lightweight probe for keychain-stored credentials. We pick
  // fs.existsSync over `claude mcp list` because it is synchronous, has no
  // TTY-allocation surprises in CI, and never hangs on a stuck binary. The
  // tradeoff is that we trust file presence without parsing — a corrupt
  // credentials file will still fail at runtime, but it will fail loudly
  // with the binary's own error rather than silently here.
  if (existsSync(join(homedir(), '.claude', '.credentials.json'))) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok({
      ok: true,
      billingSource: 'subscription',
      detail: 'subscription (interactive credentials)',
    });
  }

  // (3) No subscription signal. ANTHROPIC_API_KEY is intentionally NOT a
  // valid fallback here — the user picked claude-cli, which means they want
  // subscription billing; an API key in the env is something to strip from
  // the subprocess, not something to silently route the run through. When a
  // key is nonetheless present, point that out so the user does not assume
  // it is in use.
  if (args.hasApiKey) {
    return err(
      new ClaudeAuthError(CLI_API_KEY_NOT_USABLE, {
        envObserved: ['ANTHROPIC_API_KEY'],
        billingSource: 'subscription',
      }),
    );
  }
  return err(
    new ClaudeAuthError(CLI_REQUIRES_SUBSCRIPTION, {
      envObserved: [],
      billingSource: 'subscription',
    }),
  );
}

function cloudRoutingAuthState(args: {
  useBedrock: boolean;
  useVertex: boolean;
  foundryUrl: string | undefined;
}): AuthState {
  if (args.useBedrock) {
    return {
      ok: true,
      billingSource: 'bedrock',
      detail: 'routing via AWS Bedrock (CLAUDE_CODE_USE_BEDROCK=1)',
    };
  }
  if (args.useVertex) {
    return {
      ok: true,
      billingSource: 'vertex',
      detail: 'routing via Google Vertex (CLAUDE_CODE_USE_VERTEX=1)',
    };
  }
  // Foundry is the remaining branch when hasCloudRouting was true.
  return {
    ok: true,
    billingSource: 'foundry',
    detail: isNonEmpty(args.foundryUrl)
      ? 'routing via Azure Foundry (ANTHROPIC_FOUNDRY_URL set)'
      : 'routing via Azure Foundry (CLAUDE_CODE_USE_FOUNDRY=1)',
  };
}

/**
 * Env keys forwarded to the `claude --version` preflight probe. Mirrors the
 * vars that `buildEnvAllowlist` always includes. PATH/Path covers both POSIX
 * and Windows binary resolution; HOME/USERPROFILE covers user-config lookup on
 * both platforms; the rest prevent locale and temp-dir surprises.
 */
const PREFLIGHT_ENV_KEYS = [
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'USER',
  'LANG',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'SHELL',
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
