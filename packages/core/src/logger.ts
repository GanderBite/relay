/**
 * @relay/core — Logger
 *
 * Per §4.10: two log streams — NDJSON to a per-run log file, and a colorized
 * human-readable line to stdout when running in a TTY. No external log library;
 * plain JSON.stringify writes to a WriteStream.
 *
 * Level ordering: debug < info < warn < error.
 * Messages below the configured threshold are dropped.
 *
 * stepId resolution: the method-level stepId takes precedence over the pinned
 * stepId supplied to child(). If neither is present, the field is omitted.
 */

import * as fs from 'node:fs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEvent = {
  ts: string;
  level: LogLevel;
  flowName: string;
  runId: string;
  stepId?: string;
  /** e.g. 'step.start', 'prompt.token_update', 'step.failed' */
  event: string;
  data?: Record<string, unknown>;
};

export interface LoggerOptions {
  runId: string;
  flowName: string;
  /** Absolute path to the NDJSON log file. Created with append flag. */
  logFile?: string;
  /** Emit colorized lines to stdout. Only activates when stdout is a TTY. */
  console?: boolean;
  /** Minimum level to emit. Messages below this threshold are dropped. Default: 'info'. */
  level?: LogLevel;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * ANSI color codes keyed by level.
 * Applied only when stdout is a TTY and NO_COLOR is not set.
 */
const ANSI: Record<LogLevel, string> = {
  debug: '\x1b[2m',   // dim
  info: '',            // no color
  warn: '\x1b[33m',   // yellow
  error: '\x1b[31m',  // red
};

const ANSI_RESET = '\x1b[0m';

/** Level prefix symbols drawn from the Relay symbol vocabulary. */
const LEVEL_SYMBOL: Record<LogLevel, string> = {
  debug: '·',
  info: '·',
  warn: '⚠',
  error: '✕',
};

function shouldUseColor(): boolean {
  return Boolean(process.stdout.isTTY) && !process.env['NO_COLOR'];
}

function formatConsole(event: LogEvent): string {
  const useColor = shouldUseColor();
  const symbol = LEVEL_SYMBOL[event.level];
  const prefix = useColor ? (ANSI[event.level] ?? '') : '';
  const suffix = useColor && prefix ? ANSI_RESET : '';

  const stepPart = event.stepId != null ? ` [${event.stepId}]` : '';
  const dataPart =
    event.data != null && Object.keys(event.data).length > 0
      ? ` ${JSON.stringify(event.data)}`
      : '';

  return `${prefix}${symbol} ${event.ts} ${event.level.padEnd(5)} ${event.flowName}${stepPart} ${event.event}${dataPart}${suffix}`;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  readonly runId: string;
  readonly flowName: string;

  private readonly _stream: fs.WriteStream | undefined;
  private readonly _console: boolean;
  private readonly _threshold: number;
  private readonly _pinnedStepId: string | undefined;

  constructor(options: LoggerOptions, pinnedStepId?: string) {
    this.runId = options.runId;
    this.flowName = options.flowName;
    this._console = options.console ?? false;
    this._threshold = LEVEL_ORDER[options.level ?? 'info'] ?? LEVEL_ORDER['info'];
    this._pinnedStepId = pinnedStepId;

    if (options.logFile != null) {
      const stream = fs.createWriteStream(options.logFile, { flags: 'a' });
      stream.on('error', (err: Error) => {
        process.stderr.write(
          `relay logger write error (${options.logFile ?? 'unknown'}): ${err.message}\n`,
        );
      });
      this._stream = stream;
    }
  }

  // -------------------------------------------------------------------------
  // Public log methods
  // -------------------------------------------------------------------------

  debug(event: string, data?: Record<string, unknown>, stepId?: string): void {
    this._emit('debug', event, data, stepId);
  }

  info(event: string, data?: Record<string, unknown>, stepId?: string): void {
    this._emit('info', event, data, stepId);
  }

  warn(event: string, data?: Record<string, unknown>, stepId?: string): void {
    this._emit('warn', event, data, stepId);
  }

  error(event: string, data?: Record<string, unknown>, stepId?: string): void {
    this._emit('error', event, data, stepId);
  }

  // -------------------------------------------------------------------------
  // child() — returns a scoped logger with a pinned stepId
  // -------------------------------------------------------------------------

  /**
   * Returns a new Logger that emits the same runId/flowName/stream/level/console
   * settings, but with `stepId` pinned so all calls automatically include it.
   *
   * The method-level stepId still takes precedence over the pinned one if both
   * are provided to a call.
   */
  child(stepId: string): Logger {
    const childOptions: LoggerOptions = {
      runId: this.runId,
      flowName: this.flowName,
      console: this._console,
      level: this._levelName(),
    };
    // Share the underlying WriteStream rather than opening a second one.
    const child = new Logger(childOptions, stepId);
    // Overwrite the private stream slot to share the parent's stream.
    (child as WritableChild)._sharedStream = this._stream;
    return child;
  }

  // -------------------------------------------------------------------------
  // close() — flush and close the underlying stream if owned by this logger
  // -------------------------------------------------------------------------

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (this._stream == null) {
        resolve();
        return;
      }
      this._stream.end(resolve);
    });
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private _emit(
    level: LogLevel,
    event: string,
    data: Record<string, unknown> | undefined,
    stepId: string | undefined,
  ): void {
    const levelOrder = LEVEL_ORDER[level];
    if (levelOrder == null || levelOrder < this._threshold) return;

    // Method-level stepId takes precedence over the pinned one.
    const resolvedStepId = stepId ?? this._pinnedStepId;

    const logEvent: LogEvent = {
      ts: new Date().toISOString(),
      level,
      flowName: this.flowName,
      runId: this.runId,
      ...(resolvedStepId != null ? { stepId: resolvedStepId } : {}),
      event,
      ...(data != null ? { data } : {}),
    };

    // NDJSON to file stream (shared stream for child loggers, own stream otherwise).
    const stream = (this as WritableChild)._sharedStream ?? this._stream;
    if (stream != null) {
      stream.write(JSON.stringify(logEvent) + '\n');
    }

    // Colorized line to stdout (only when console:true AND TTY).
    if (this._console && Boolean(process.stdout.isTTY)) {
      process.stdout.write(formatConsole(logEvent) + '\n');
    }
  }

  private _levelName(): LogLevel {
    for (const [name, order] of Object.entries(LEVEL_ORDER) as Array<[LogLevel, number]>) {
      if (order === this._threshold) return name;
    }
    return 'info';
  }
}

// ---------------------------------------------------------------------------
// Internal interface for shared-stream child loggers (avoids opening duplicate
// WriteStreams when child() is called).
// ---------------------------------------------------------------------------

interface WritableChild {
  _sharedStream?: fs.WriteStream | undefined;
}
