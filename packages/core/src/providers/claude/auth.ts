/**
 * Per-provider auth inspection — runs BEFORE any Claude SDK call or
 * `claude -p` subprocess and decides whether the run may proceed.
 *
 * Two providers, two billing surfaces, two TOS contracts:
 *
 *   claude-agent-sdk → calls the Anthropic API directly. Anthropic's
 *     commercial terms do not permit Pro/Max subscription credentials to be
 *     used through the SDK, so a `CLAUDE_CODE_OAUTH_TOKEN` in the host env
 *     under this provider is a TOS-leak risk that is blocked here.
 *
 *   claude-cli      → spawns the `claude -p` binary, which uses the user's
 *     stored subscription credentials. An `ANTHROPIC_API_KEY` in the host
 *     env would silently route tokens through the API, which is the inverse
 *     of what the user asked for when they picked this provider.
 *
 * Cloud routing (Bedrock/Vertex/Foundry) bypasses both checks under either
 * provider — those tokens bill to the cloud account, not to Anthropic.
 *
 * Returns `Result<AuthState, ClaudeAuthError>`. Never throws.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { err, ok, type Result } from 'neverthrow';

import { ClaudeAuthError, SubscriptionTosLeakError } from '../../errors.js';
import type { AuthState } from '../types.js';

const execFileAsync = promisify(execFile);

/** Short wall-clock limit for `claude --version`. Enough for a cold binary, not so long that a stuck PATH entry stalls the run. */
const CLAUDE_VERSION_TIMEOUT_MS = 5_000;

/** Returned when the `claude` binary is not on PATH. */
const CLAUDE_MISSING_MESSAGE =
  'claude command not found on PATH. Install it: npm install -g @anthropic-ai/claude-code';

/** Remediation when the SDK provider has no API key and no cloud routing. */
const SDK_REQUIRES_API_KEY =
  'claude-agent-sdk requires ANTHROPIC_API_KEY. Set it, or run `relay init` and choose claude-cli.';

/** Remediation when an OAuth subscription token is present under the SDK provider — TOS forbids that combination. */
const SDK_TOS_LEAK_MESSAGE =
  'subscription tokens may not be used with claude-agent-sdk. Set ANTHROPIC_API_KEY for API billing, or switch to claude-cli.';

/** Remediation when the CLI provider has no detectable subscription credentials. */
const CLI_REQUIRES_SUBSCRIPTION =
  'claude-cli requires subscription auth. Run `claude /login`, or run `relay init` and choose claude-agent-sdk.';

/** Warning surfaced once per run whenever the SDK provider routes via API account billing. */
const API_ACCOUNT_WARNING = 'billing to API account, not subscription';

/** Provider identifiers accepted by `inspectClaudeAuth`. */
export type ClaudeProviderKind = 'claude-agent-sdk' | 'claude-cli';

export interface InspectClaudeAuthOptions {
  /** Which Claude-backed provider is asking. Determines which TOS contract is enforced. */
  providerKind: ClaudeProviderKind;
}

/**
 * Inspect the host env and return the billing surface that the chosen
 * provider would use, or an error explaining why the run cannot proceed.
 *
 * Per-provider precedence (a match short-circuits the rest):
 *
 *   Both providers — cloud routing wins:
 *     CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
 *     CLAUDE_CODE_USE_FOUNDRY / ANTHROPIC_FOUNDRY_URL
 *
 *   claude-agent-sdk:
 *     1. ANTHROPIC_API_KEY set → ok(api-account) with warning.
 *     2. CLAUDE_CODE_OAUTH_TOKEN set without ANTHROPIC_API_KEY → err(TOS-leak).
 *     3. Nothing set → err(missing API key).
 *
 *   claude-cli:
 *     1. CLAUDE_CODE_OAUTH_TOKEN set → ok(subscription, token mode).
 *     2. ~/.claude/.credentials.json present → ok(subscription, interactive).
 *     3. Otherwise (including ANTHROPIC_API_KEY-only) → err(missing subscription).
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
  const useFoundry =
    env.CLAUDE_CODE_USE_FOUNDRY === '1' || isNonEmpty(env.ANTHROPIC_FOUNDRY_URL);
  const hasCloudRouting = useBedrock || useVertex || useFoundry;

  // Cloud routing is acceptable under either provider; tokens bill to the
  // cloud account and neither TOS contract applies. Decide before any of the
  // provider-specific branches so a misconfigured ANTHROPIC_API_KEY or
  // CLAUDE_CODE_OAUTH_TOKEN does not block a legitimate cloud-routed run.
  if (hasCloudRouting) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok(cloudRoutingAuthState({ useBedrock, useVertex, foundryUrl: env.ANTHROPIC_FOUNDRY_URL }));
  }

  if (opts.providerKind === 'claude-agent-sdk') {
    return inspectAgentSdk({ hasApiKey, hasOauth });
  }
  return inspectCli({ hasOauth });
}

async function inspectAgentSdk(args: {
  hasApiKey: boolean;
  hasOauth: boolean;
}): Promise<Result<AuthState, ClaudeAuthError>> {
  // (1) An API key wins — the SDK's own auth precedence puts ANTHROPIC_API_KEY
  // ahead of any subscription token, so the OAuth env var is harmless here
  // and we surface the API-account billing warning instead.
  if (args.hasApiKey) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok({
      ok: true,
      billingSource: 'api-account',
      detail: 'API account (ANTHROPIC_API_KEY)',
      warnings: [API_ACCOUNT_WARNING],
    });
  }

  // (2) OAuth subscription token without an API key is a TOS leak under the
  // SDK provider. Block before launching anything.
  if (args.hasOauth) {
    return err(
      new SubscriptionTosLeakError(SDK_TOS_LEAK_MESSAGE, {
        envObserved: ['CLAUDE_CODE_OAUTH_TOKEN'],
        billingSource: 'subscription',
      }),
    );
  }

  // (3) Nothing at all — the SDK has no credentials to authenticate with.
  return err(
    new ClaudeAuthError(SDK_REQUIRES_API_KEY, {
      envObserved: [],
      billingSource: 'api-account',
    }),
  );
}

async function inspectCli(args: {
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
  // the subprocess, not something to silently route the run through.
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
