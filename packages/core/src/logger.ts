/**
 * @relay/core — Logger
 *
 * Two destinations: NDJSON append to a per-run log file and a colorized
 * human-readable stream to stdout when running in a TTY.
 *
 * Level ordering: debug < info < warn < error.
 * Messages below the configured threshold are dropped.
 *
 * stepId resolution: the method-level stepId takes precedence over the
 * stepId pinned via child(). If neither is present, the field is omitted.
 *
 * child() returns an instanceof Logger with a pino child logger underneath;
 * it shares the parent's destinations rather than re-opening them.
 *
 * close() is safe to call multiple times; subsequent calls resolve immediately.
 */

import pino from 'pino';
import PinoPretty from 'pino-pretty';
import * as nodePath from 'node:path';
import * as nodeFs from 'node:fs';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEvent = {
  ts: string;
  level: LogLevel;
  flowName: string;
  runId: string;
  stepId?: string;
  event: string;
  data?: Record<string, unknown>;
};

export interface LoggerOptions {
  runId: string;
  flowName: string;
  /** Absolute path to the NDJSON log file. Created in append mode; parent dirs are created if needed. */
  logFile?: string;
  /** Emit colorized lines to stdout. Only activates when stdout is a TTY and NO_COLOR is unset. */
  console?: boolean;
  /** Minimum level to emit. Defaults to 'info'. */
  level?: LogLevel;
}

// ---------------------------------------------------------------------------
// Internal merge-object shape passed to each pino log call
// ---------------------------------------------------------------------------

interface LogMergeObject {
  stepId?: string;
  data?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Symbol vocabulary for the pretty stream
// ---------------------------------------------------------------------------

const LEVEL_SYMBOL: Record<string, string> = {
  debug: '·',
  info: '·',
  warn: '⚠',
  error: '✕',
};

// ---------------------------------------------------------------------------
// Build the pino-pretty stream for stdout
// ---------------------------------------------------------------------------

function buildPrettyStream(): PinoPretty.PrettyStream {
  const useColor = !process.env['NO_COLOR'];
  return PinoPretty({
    destination: 1, // stdout fd
    colorize: useColor,
    colorizeObjects: useColor,
    // The message is stored under the 'event' key (our messageKey).
    messageKey: 'event',
    // Timestamps are stored under 'ts'.
    timestampKey: 'ts',
    // Keep ts, level, event and our custom fields; drop pid/hostname/v.
    ignore: 'pid,hostname',
    // Single-line output keeps structured data on the same line.
    singleLine: true,
    // Translate the raw ISO string as-is (no reformatting).
    translateTime: false,
    messageFormat: (log, messageKey, levelLabel, _extras) => {
      const symbol = LEVEL_SYMBOL[levelLabel] ?? '·';
      const ts = typeof log['ts'] === 'string' ? log['ts'] : '';
      const level = levelLabel.padEnd(5);
      const flowName = typeof log['flowName'] === 'string' ? log['flowName'] : '';
      const stepId = typeof log['stepId'] === 'string' ? `[${log['stepId']}]` : '';
      const sep = stepId.length > 0 ? ' ' : '';
      const event = typeof log[messageKey] === 'string' ? log[messageKey] : String(log[messageKey] ?? '');
      const data = log['data'] != null && typeof log['data'] === 'object' && Object.keys(log['data']).length > 0
        ? ` ${JSON.stringify(log['data'])}`
        : '';
      return `${symbol} ${ts} ${level} ${flowName}${sep}${stepId} ${event}${data}`;
    },
  });
}

// ---------------------------------------------------------------------------
// Duck-typed interface for the SonicBoom destination returned by pino.destination().
// We only call flushSync() and end() on it.
// ---------------------------------------------------------------------------

interface SonicBoomLike extends pino.DestinationStream {
  flushSync(): void;
  end(): void;
}

// ---------------------------------------------------------------------------
// Internal constructor arguments (not part of the public API)
// ---------------------------------------------------------------------------

interface LoggerInternals {
  pinoInstance: pino.Logger;
  fileDestination: SonicBoomLike | undefined;
  pinnedStepId: string | undefined;
}

// ---------------------------------------------------------------------------
// Logger
// ---------------------------------------------------------------------------

export class Logger {
  readonly runId: string;
  readonly flowName: string;

  private readonly _pino: pino.Logger;
  private readonly _fileDestination: SonicBoomLike | undefined;
  private readonly _pinnedStepId: string | undefined;
  private _closed: boolean = false;

  /**
   * Public constructor. Pass LoggerOptions to create a root logger.
   * The second argument is reserved for internal child-construction.
   */
  constructor(options: LoggerOptions, internals?: LoggerInternals) {
    this.runId = options.runId;
    this.flowName = options.flowName;

    if (internals != null) {
      // Child logger path — reuse the already-built pino instance and destination.
      this._pino = internals.pinoInstance;
      this._fileDestination = internals.fileDestination;
      this._pinnedStepId = internals.pinnedStepId;
      return;
    }

    // Root logger path — build destinations and create the pino instance.
    const level = options.level ?? 'info';
    const streams: pino.StreamEntry[] = [];

    let fileDestination: SonicBoomLike | undefined;
    if (options.logFile != null) {
      const dir = nodePath.dirname(options.logFile);
      nodeFs.mkdirSync(dir, { recursive: true });
      fileDestination = pino.destination({
        dest: options.logFile,
        append: true,
        sync: false,
      });
      streams.push({ stream: fileDestination, level });
    }

    const usePretty = options.console === true && Boolean(process.stdout.isTTY);
    if (usePretty) {
      streams.push({ stream: buildPrettyStream(), level });
    }

    // When no destinations are configured, route to a null sink so pino
    // still performs level filtering without writing anything.
    const destination: pino.DestinationStream =
      streams.length === 0
        ? { write(_msg: string) { /* intentional no-op */ } }
        : streams.length === 1
          ? (streams[0]!.stream)
          : pino.multistream(streams, { dedupe: false });

    this._pino = pino(
      {
        level,
        // Rename the message field from 'msg' to 'event'.
        messageKey: 'event',
        // Include flowName and runId in every log line via base bindings.
        base: { flowName: options.flowName, runId: options.runId },
        // Custom ISO timestamp under 'ts' key instead of the default 'time'.
        timestamp: () => `,"ts":"${new Date().toISOString()}"`,
        formatters: {
          // Emit the level as a string label instead of a numeric value.
          level: (label: string) => ({ level: label }),
          // Suppress pid and hostname from the base bindings block.
          bindings: (bindings: pino.Bindings) => {
            const { pid: _pid, hostname: _hostname, ...rest } = bindings as {
              pid?: unknown;
              hostname?: unknown;
              [k: string]: unknown;
            };
            return rest;
          },
          // Keep the merge object as-is; pino already places these fields
          // at the top level alongside 'event'.
          log: (obj: Record<string, unknown>) => obj,
        },
      },
      destination,
    );

    this._fileDestination = fileDestination;
    this._pinnedStepId = undefined;
  }

  // -------------------------------------------------------------------------
  // Public log methods — signature matches the contract exactly.
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
  // child() — returns an instanceof Logger pinned to a stepId.
  // -------------------------------------------------------------------------

  /**
   * Returns a new Logger that emits all the same destinations, with the
   * given stepId included on every log line. A method-level stepId still
   * takes precedence over the pinned one.
   */
  child(stepId: string): Logger {
    const childPino = this._pino.child({ stepId });
    return new Logger(
      { runId: this.runId, flowName: this.flowName },
      {
        pinoInstance: childPino,
        fileDestination: this._fileDestination,
        pinnedStepId: stepId,
      },
    );
  }

  // -------------------------------------------------------------------------
  // close() — flush and close the file destination.
  // -------------------------------------------------------------------------

  close(): Promise<void> {
    if (this._closed) return Promise.resolve();
    this._closed = true;

    if (this._fileDestination == null) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this._fileDestination!.flushSync();
      this._fileDestination!.end();
      resolve();
    });
  }

  // -------------------------------------------------------------------------
  // Internal emit helper
  // -------------------------------------------------------------------------

  private _emit(
    level: LogLevel,
    event: string,
    data: Record<string, unknown> | undefined,
    stepId: string | undefined,
  ): void {
    // Method-level stepId takes precedence over the pinned one.
    const resolvedStepId = stepId ?? this._pinnedStepId;

    const merge: LogMergeObject = {};
    if (resolvedStepId != null) merge.stepId = resolvedStepId;
    if (data != null) merge.data = data;

    // pino.child already carries the pinned stepId in its bindings, but we
    // pass it explicitly so method-level override works correctly.
    this._pino[level](merge, event);
  }
}
