/**
 * relay logs <runId> — pretty-prints the structured NDJSON run log.
 *
 * Log source: <cwd>/.relay/runs/<runId>/run.log
 * Each line is a JSON object with shape:
 *   { ts, level, event, stepId?, data?, ...rest }
 *
 * Output format per event:
 *   <HH:MM:SS>  <level colored>  <event>  <key=value pairs>
 *
 * Flags (parsed from process.argv directly — same pattern as runs.ts):
 *   --step <id>    filter to events with matching stepId
 *   --follow / -f  tail mode: print existing lines then watch for new ones
 *   --level <lvl>  filter to minimum level (debug < info < warn < error)
 *
 * Unknown runId:
 *   ✕ no such run: <runId>
 *
 *   → relay runs
 */

import { createReadStream, watch } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { MARK, SYMBOLS } from '../brand.js';
import { gray, green, red, yellow } from '../color.js';

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function levelRank(level: string): number {
  return LEVEL_ORDER[level] ?? 1;
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

interface LogFlags {
  step: string | undefined;
  follow: boolean;
  minLevel: string;
}

function parseFlags(): LogFlags {
  const argv = process.argv;
  let step: string | undefined;
  let follow = false;
  let minLevel = 'debug';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--follow' || arg === '-f') {
      follow = true;
    }
    if (arg === '--step' && i + 1 < argv.length) {
      step = argv[i + 1];
    }
    if (arg === '--level' && i + 1 < argv.length) {
      const val = argv[i + 1];
      if (val !== undefined && val in LEVEL_ORDER) {
        minLevel = val;
      }
    }
  }

  return { step, follow, minLevel };
}

// ---------------------------------------------------------------------------
// Log event shape
// ---------------------------------------------------------------------------

interface LogEvent {
  ts?: string;
  level?: string;
  event?: string;
  stepId?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Level coloring
// ---------------------------------------------------------------------------

function colorLevel(level: string): string {
  switch (level) {
    case 'error':
      return red(level);
    case 'warn':
      return yellow(level);
    case 'info':
      return green(level);
    case 'debug':
      return gray(level);
    default:
      return gray(level);
  }
}

// ---------------------------------------------------------------------------
// Timestamp formatting
// ---------------------------------------------------------------------------

function formatTime(ts: string | undefined): string {
  if (ts === undefined) return '--:--:--';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '--:--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

// ---------------------------------------------------------------------------
// Key-value extras renderer
// ---------------------------------------------------------------------------

/**
 * Render a LogEvent's fields (excluding ts, level, event, stepId, flowName,
 * runId) as space-separated key=value pairs. Nested data object fields are
 * flattened one level.
 */
function renderExtras(evt: LogEvent): string {
  const SKIP = new Set(['ts', 'level', 'event', 'stepId', 'flowName', 'runId', 'data']);
  const pairs: string[] = [];

  if (evt.stepId !== undefined) {
    pairs.push(`stepId=${String(evt.stepId)}`);
  }

  for (const [k, v] of Object.entries(evt)) {
    if (SKIP.has(k)) continue;
    pairs.push(`${k}=${String(v)}`);
  }

  if (evt.data !== undefined && typeof evt.data === 'object') {
    for (const [k, v] of Object.entries(evt.data)) {
      pairs.push(`${k}=${String(v)}`);
    }
  }

  return pairs.join(' ');
}

// ---------------------------------------------------------------------------
// Single event renderer
// ---------------------------------------------------------------------------

function renderEvent(evt: LogEvent): string {
  const time = formatTime(evt.ts);
  const eventName = String(evt.event ?? '(unknown)');
  const extras = renderExtras(evt);

  const levelColored = colorLevel(String(evt.level ?? 'info')).padEnd(5);
  const parts = [gray(time), levelColored, eventName];
  if (extras.length > 0) {
    parts.push(gray(extras));
  }
  return parts.join('  ');
}

// ---------------------------------------------------------------------------
// Event filter
// ---------------------------------------------------------------------------

function shouldShow(evt: LogEvent, flags: LogFlags): boolean {
  // Level filter
  const rank = levelRank(String(evt.level ?? 'info'));
  if (rank < levelRank(flags.minLevel)) return false;

  // Runner filter
  if (flags.step !== undefined && evt.stepId !== flags.step) return false;

  return true;
}

// ---------------------------------------------------------------------------
// NDJSON line parser
// ---------------------------------------------------------------------------

function parseLine(line: string): LogEvent | null {
  const trimmed = line.trim();
  if (trimmed.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LogEvent;
    }
    return null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// State file reader — for flowName in header
// ---------------------------------------------------------------------------

interface MinimalState {
  flowName?: string;
}

async function readFlowName(runDir: string): Promise<string> {
  try {
    const raw = await readFile(join(runDir, 'state.json'), { encoding: 'utf8' });
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      typeof (parsed as MinimalState).flowName === 'string'
    ) {
      return (parsed as MinimalState).flowName as string;
    }
  } catch {
    // fall through
  }
  return '<unknown>';
}

// ---------------------------------------------------------------------------
// Stream existing log lines
// ---------------------------------------------------------------------------

async function streamExisting(logPath: string, flags: LogFlags): Promise<number> {
  let lastPos = 0;

  return new Promise<number>((resolve, reject) => {
    const stream = createReadStream(logPath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      const evt = parseLine(line);
      if (evt !== null && shouldShow(evt, flags)) {
        process.stdout.write(renderEvent(evt) + '\n');
      }
    });

    rl.on('close', () => {
      // Track approximate byte offset for follow mode.
      // We reuse the stream's bytesRead if available.
      const s = stream as typeof stream & { bytesRead?: number };
      lastPos = s.bytesRead ?? 0;
      resolve(lastPos);
    });

    rl.on('error', reject);
    stream.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Follow mode — watch for new lines appended to the file
// ---------------------------------------------------------------------------

async function followLog(logPath: string, startPos: number, flags: LogFlags): Promise<void> {
  let currentPos = startPos;

  const readNew = async (): Promise<void> => {
    return new Promise<void>((resolve) => {
      const stream = createReadStream(logPath, {
        encoding: 'utf8',
        start: currentPos,
      });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });

      rl.on('line', (line) => {
        const evt = parseLine(line);
        if (evt !== null && shouldShow(evt, flags)) {
          process.stdout.write(renderEvent(evt) + '\n');
        }
      });

      rl.on('close', () => {
        const s = stream as typeof stream & { bytesRead?: number };
        currentPos += s.bytesRead ?? 0;
        resolve();
      });

      stream.on('error', () => resolve());
    });
  };

  // Watch for file changes (append events).
  const watcher = watch(logPath, { persistent: true });

  watcher.on('change', () => {
    void readNew();
  });

  // Handle SIGINT gracefully.
  process.on('SIGINT', () => {
    watcher.close();
    process.exit(0);
  });

  // Keep alive until SIGINT.
  await new Promise<void>(() => {
    // Intentionally never resolves — exits via SIGINT handler above.
  });
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay logs <runId>`.
 */
export default async function logsCommand(args: unknown[], _opts: unknown): Promise<void> {
  const runId = String(args[0] ?? '');
  const flags = parseFlags();

  const runsDir = join(process.cwd(), '.relay', 'runs');
  const runDir = join(runsDir, runId);

  // Check that the run directory exists.
  try {
    await access(runDir);
  } catch {
    process.stdout.write(`${SYMBOLS.fail} no such run: ${runId}\n`);
    process.stdout.write('\n');
    process.stdout.write(`${gray('→')} relay runs\n`);
    process.exit(1);
  }

  // Read flowName from state.json (best-effort).
  const flowName = await readFlowName(runDir);

  // Print header.
  process.stdout.write(`${MARK}  logs for ${runId}  ${SYMBOLS.dot}  ${flowName}\n`);
  process.stdout.write('\n');

  const logPath = join(runDir, 'run.log');

  // Check whether run.log exists.
  let logExists = false;
  try {
    await access(logPath);
    logExists = true;
  } catch {
    // run.log does not exist yet.
  }

  if (!logExists) {
    if (!flags.follow) {
      process.stdout.write('  (no log entries)\n');
      process.exit(0);
    }
    // Follow mode with no log yet — watch the directory for the file to appear,
    // then stream it. Use fs.watch on the run directory.
    const dirWatcher = watch(runDir, { persistent: true });

    dirWatcher.on('change', (_eventType, filename) => {
      if (filename === 'run.log') {
        dirWatcher.close();
        void (async () => {
          const pos = await streamExisting(logPath, flags);
          await followLog(logPath, pos, flags);
        })();
      }
    });

    process.on('SIGINT', () => {
      dirWatcher.close();
      process.exit(0);
    });

    // Keep alive.
    await new Promise<void>(() => {
      // Exits via SIGINT or when run.log appears.
    });
    return;
  }

  // Stream existing lines.
  const lastPos = await streamExisting(logPath, flags);

  if (flags.follow) {
    await followLog(logPath, lastPos, flags);
  }
}
