/**
 * Auth inspection for the claude-cli provider — runs BEFORE any `claude -p`
 * subprocess and decides whether the run may proceed.
 *
 * The claude-cli provider spawns the `claude` binary using the user's stored
 * subscription credentials. Cloud routing (Bedrock/Vertex/Foundry) bypasses
 * the subscription check — those tokens bill to the cloud account.
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
  'claude-cli requires subscription auth. Run `claude /login`, then re-run `relay init`.';

/**
 * Inspect the host env and return the billing surface the claude-cli provider
 * would use, or an error explaining why the run cannot proceed.
 *
 * Precedence (a match short-circuits the rest):
 *
 *   Cloud routing wins:
 *     CLAUDE_CODE_USE_BEDROCK / CLAUDE_CODE_USE_VERTEX
 *     CLAUDE_CODE_USE_FOUNDRY / ANTHROPIC_FOUNDRY_URL
 *
 *   Otherwise:
 *     1. CLAUDE_CODE_OAUTH_TOKEN set → ok(subscription, token mode).
 *     2. ~/.claude/.credentials.json present → ok(subscription, interactive).
 *     3. Otherwise → err(missing subscription).
 *
 * After deciding, spawns `claude --version` to confirm the binary exists.
 * The probe runs after the policy check so a misconfigured machine never
 * reaches a subprocess at all.
 */
export async function inspectClaudeAuth(): Promise<Result<AuthState, ClaudeAuthError>> {
  const env = process.env;
  const hasOauth = isNonEmpty(env.CLAUDE_CODE_OAUTH_TOKEN);

  const useBedrock = env.CLAUDE_CODE_USE_BEDROCK === '1';
  const useVertex = env.CLAUDE_CODE_USE_VERTEX === '1';
  const useFoundry = env.CLAUDE_CODE_USE_FOUNDRY === '1' || isNonEmpty(env.ANTHROPIC_FOUNDRY_URL);
  const hasCloudRouting = useBedrock || useVertex || useFoundry;

  // Cloud routing is acceptable; tokens bill to the cloud account and the
  // subscription contract does not apply.
  if (hasCloudRouting) {
    const binaryCheck = await ensureClaudeBinary();
    if (binaryCheck.isErr()) return err(binaryCheck.error);
    return ok(
      cloudRoutingAuthState({ useBedrock, useVertex, foundryUrl: env.ANTHROPIC_FOUNDRY_URL }),
    );
  }

  return inspectCli({ hasOauth });
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

  // (3) No subscription signal — reject before reaching any subprocess.
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
