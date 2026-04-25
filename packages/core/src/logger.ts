// Scoped NDJSON logger. Factory returns a pino instance pre-bound with
// flowName/runId; per-step scope is logger.child({ stepId }). Secret redaction
// is on by default so accidental dumps of env or auth headers stay safe.
//
// ANSI color output is stripped from console (stdout) streams when color is
// disabled. Color is considered disabled when:
//   1. NO_COLOR env variable is set (non-empty).
//   2. stdout is not a TTY.
//   3. color='never' in ~/.relay/settings.json.
// The settings file is read once synchronously at module load.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import pino, { type DestinationStream, type LoggerOptions, type Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

// Required shape for every log line. flowName/runId are seeded by the factory;
// stepId is attached via child bindings; event names the operation.
export interface LogEvent {
  flowName: string;
  runId: string;
  stepId?: string;
  event: string;
  [extra: string]: unknown;
}

export interface CreateLoggerOptions {
  flowName: string;
  runId: string;
  // When set, NDJSON is written to this path in addition to stdout. Parent
  // directories are created automatically.
  logFile?: string;
  // Defaults to process.env.LOG_LEVEL or 'info'.
  level?: string;
}

// ---------------------------------------------------------------------------
// ANSI stripping — applied to console output when color is disabled.
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI ESC stripping requires matching U+001B
const ANSI_SGR_PATTERN = /\u001B\[[\d;]*m/g;

/** Strip ANSI SGR escape sequences from a string. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR_PATTERN, '');
}

/** Read color setting from ~/.relay/settings.json synchronously at module load. */
function readSettingsColorField(): 'auto' | 'always' | 'never' | null {
  try {
    const raw = readFileSync(join(homedir(), '.relay', 'settings.json'), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const color = (parsed as Record<string, unknown>)['color'];
      if (color === 'auto' || color === 'always' || color === 'never') {
        return color;
      }
    }
  } catch {
    // File absent or unreadable — fall through to TTY detection.
  }
  return null;
}

/**
 * True when console output should have ANSI codes stripped.
 * Precedence mirrors visual.ts:
 *   1. NO_COLOR env (non-empty) wins.
 *   2. color='never' in settings wins over TTY auto-detect.
 *   3. !stdout.isTTY is the fallback.
 *   color='always' in settings forces color on regardless of TTY.
 */
function resolveConsoleColorDisabled(): boolean {
  if (process.env['NO_COLOR'] !== undefined && process.env['NO_COLOR'] !== '') return true;
  const setting = readSettingsColorField();
  if (setting === 'never') return true;
  if (setting === 'always') return false;
  return !process.stdout.isTTY;
}

/** True when console output should have ANSI codes stripped (resolved at module load). */
export const CONSOLE_COLOR_DISABLED = resolveConsoleColorDisabled();

const IS_DEV = process.env.NODE_ENV === 'development';

const REDACT_PATHS: readonly string[] = [
  '*.CLAUDE_CODE_OAUTH_TOKEN',
  'env',
  'environment',
  'process.env',
];

const SENSITIVE_SUFFIX_RE = /(_api_key|_token|_secret|_password)$/i;
const SENSITIVE_PREFIX_RE = /^(anthropic_|claude_code_)/i;
const SENSITIVE_EXACT = new Set(['authorization', 'Authorization', 'cookie', 'Cookie']);

function isSensitiveKey(key: string): boolean {
  return (
    SENSITIVE_EXACT.has(key) ||
    SENSITIVE_SUFFIX_RE.test(key) ||
    SENSITIVE_PREFIX_RE.test(key) ||
    /password/i.test(key)
  );
}

function redactObj(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isSensitiveKey(k) ? '[redacted]' : redactObj(v);
  }
  return out;
}

export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const pinoOptions: LoggerOptions = {
    level,
    base: { flowName: opts.flowName, runId: opts.runId },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
    formatters: {
      log: (obj) => redactObj(obj) as Record<string, unknown>,
    },
  };

  // pino-pretty is loaded only in development; production writes raw NDJSON to fd 1.
  // Colorize is disabled in dev mode when ANSI codes should be stripped.
  const stdoutDest: DestinationStream = IS_DEV
    ? pino.transport({ target: 'pino-pretty', options: { colorize: !CONSOLE_COLOR_DISABLED } })
    : pino.destination(1);

  if (opts.logFile === undefined) {
    return pino(pinoOptions, stdoutDest);
  }

  // Per-run file is always raw NDJSON regardless of env.
  const fileDest = pino.destination({ dest: opts.logFile, sync: false, mkdir: true });
  return pino(
    pinoOptions,
    pino.multistream([
      { stream: fileDest, level },
      { stream: stdoutDest, level },
    ]),
  );
}
