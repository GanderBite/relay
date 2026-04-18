// Scoped NDJSON logger. Factory returns a pino instance pre-bound with
// flowName/runId; per-step scope is logger.child({ stepId }). Secret redaction
// is on by default so accidental dumps of env or auth headers stay safe.

import pino, { type DestinationStream, type Logger as PinoLogger, type LoggerOptions } from 'pino';

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

const IS_DEV = process.env.NODE_ENV === 'development';

// Known secret keys + wildcard patterns for API keys, tokens, secrets, and
// passwords. 'env'/'environment'/'process.env' redact entire dumped envs.
const REDACT_PATHS: readonly string[] = [
  '*.ANTHROPIC_API_KEY', '*.CLAUDE_CODE_OAUTH_TOKEN',
  '*.authorization', '*.Authorization', '*.cookie', '*.Cookie',
  '*.*_API_KEY', '*.*_TOKEN', '*.*_SECRET', '*.*_PASSWORD', '*.*PASSWORD*',
  '*.ANTHROPIC_*', '*.CLAUDE_CODE_*',
  'env', 'environment', 'process.env',
];

export function createLogger(opts: CreateLoggerOptions): Logger {
  const level = opts.level ?? process.env.LOG_LEVEL ?? 'info';
  const pinoOptions: LoggerOptions = {
    level,
    base: { flowName: opts.flowName, runId: opts.runId },
    redact: { paths: [...REDACT_PATHS], censor: '[redacted]' },
  };

  // pino-pretty is loaded only in development; production writes raw NDJSON to fd 1.
  const stdoutDest: DestinationStream = IS_DEV
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
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
