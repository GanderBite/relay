/**
 * `relay runs` — lists past runs found in <cwd>/.relay/runs/.
 *
 * Output shape:
 *
 *   ●─▶●─▶●─▶●  recent runs
 *
 *    ✓  f9c3a2    codebase-discovery v0.1.0    2h ago      11m 42s
 *    ✕  a1b2c3    codebase-discovery v0.1.0    3d ago      0s
 *    ⊘  d4e5f6    codebase-discovery v0.1.0    1w ago      -
 *
 *   resume any: relay resume <runId>
 *
 * Flags (parsed from process.argv directly since the dispatcher routes this
 * command without per-subcommand option parsing):
 *   --limit N       show at most N rows (default 20)
 *   --status <s>    filter by exact run status string
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowStatus, RunState } from '@relay/core';
import { z } from 'zod';
import { MARK, SYMBOLS } from '../brand.js';
import { gray, green, red, yellow } from '../color.js';

// ---------------------------------------------------------------------------
// Minimal schema for parsing state files
// ---------------------------------------------------------------------------

const RunStateMinimalSchema = z
  .object({
    runId: z.string(),
    flowName: z.string(),
    flowVersion: z.string(),
    startedAt: z.string(),
    status: z.string(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// Column widths for the table
// ---------------------------------------------------------------------------

const RUN_ID_WIDTH = 10; // 8-char truncated id + 2 padding
const FLOW_WIDTH = 30; // "codebase-discovery v0.1.0" + padding
const TIME_WIDTH = 12; // "2h ago" + padding

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

/**
 * Convert an ISO timestamp to a human-readable relative time string.
 *
 * Ranges:
 *   < 60s    → "just now"
 *   < 3600s  → "Xm ago"
 *   < 86400s → "Xh ago"
 *   < 604800s→ "Xd ago"
 *   else     → "Xw ago"
 */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return 'just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return `${Math.floor(diffSec / 604800)}w ago`;
}

// ---------------------------------------------------------------------------
// Duration from state
// ---------------------------------------------------------------------------

/**
 * Compute a human-readable run duration from the state.
 * Uses the latest completedAt across all steps minus startedAt.
 * Returns "-" when no completed steps exist.
 */
function computeDuration(state: RunState): string {
  const stepValues = Object.values(state.steps);
  if (stepValues.length === 0) return '-';

  let maxCompletedMs = -1;
  for (const step of stepValues) {
    if (step.completedAt !== undefined) {
      const t = new Date(step.completedAt).getTime();
      if (t > maxCompletedMs) maxCompletedMs = t;
    }
  }

  if (maxCompletedMs < 0) return '-';

  const durationMs = maxCompletedMs - new Date(state.startedAt).getTime();
  if (durationMs < 0) return '-';

  const totalSec = Math.round(durationMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// Status symbol
// ---------------------------------------------------------------------------

/**
 * Map a FlowStatus (or undefined) to its colored symbol string.
 */
function statusSymbol(status: FlowStatus | string): string {
  switch (status) {
    case 'succeeded':
      return green(SYMBOLS.ok);
    case 'failed':
      return red(SYMBOLS.fail);
    case 'aborted':
      return gray(SYMBOLS.cancelled);
    case 'running':
      return yellow(SYMBOLS.spinner[0]);
    default:
      return gray(SYMBOLS.pending);
  }
}

// ---------------------------------------------------------------------------
// Flag parsing
// ---------------------------------------------------------------------------

/**
 * Parse --limit and --status from process.argv.
 * Commander only passes the global opts through the current dispatcher, so
 * subcommand-specific flags must be parsed here.
 */
function parseFlags(): { limit: number; status: string | undefined } {
  const argv = process.argv;
  let limit = 20;
  let status: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--limit' && i + 1 < argv.length) {
      const val = parseInt(argv[i + 1] ?? '', 10);
      if (!isNaN(val) && val > 0) limit = val;
    }
    if (arg === '--status' && i + 1 < argv.length) {
      status = argv[i + 1];
    }
  }

  return { limit, status };
}

// ---------------------------------------------------------------------------
// Run loader
// ---------------------------------------------------------------------------

/**
 * Load all RunState objects from <cwd>/.relay/runs/.
 * Subdirectories that have no state.json or an unparseable one are silently
 * skipped — a partially-created run dir should not break the listing.
 */
async function loadRuns(runsDir: string): Promise<RunState[]> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    // Directory does not exist — no runs yet.
    return [];
  }

  const states: RunState[] = [];

  for (const entry of entries) {
    const stateFile = join(runsDir, entry, 'state.json');
    try {
      const raw = await readFile(stateFile, { encoding: 'utf8' });
      const stateResult = RunStateMinimalSchema.safeParse(JSON.parse(raw));
      if (stateResult.success) {
        states.push(stateResult.data as unknown as RunState);
      }
    } catch {
      // Missing, unreadable, or malformed — skip silently.
    }
  }

  return states;
}

// ---------------------------------------------------------------------------
// Table row renderer
// ---------------------------------------------------------------------------

/**
 * Render a single table row for one run.
 *
 * Format:
 *   <sym>  <runId8>  <flowName vVer padded>  <relativeTime padded>  <duration>
 */
function renderRow(state: RunState): string {
  const sym = statusSymbol(state.status);
  const runId = state.runId.slice(0, 8).padEnd(RUN_ID_WIDTH);
  const flowRef = `${state.flowName} v${state.flowVersion}`.padEnd(FLOW_WIDTH);
  const timeAgo = relativeTime(state.startedAt).padEnd(TIME_WIDTH);
  const dur = computeDuration(state);

  return ` ${sym}  ${runId}${flowRef}${timeAgo}${dur}`;
}

// ---------------------------------------------------------------------------
// Main command
// ---------------------------------------------------------------------------

/**
 * Entry point for `relay runs`.
 * Lists recent runs in <cwd>/.relay/runs/, sorted newest first.
 */
export default async function runsCommand(_args: unknown[], _opts: unknown): Promise<void> {
  const { limit, status: statusFilter } = parseFlags();

  const runsDir = join(process.cwd(), '.relay', 'runs');
  const allStates = await loadRuns(runsDir);

  // Filter by status when --status was given.
  const filtered =
    statusFilter !== undefined ? allStates.filter((s) => s.status === statusFilter) : allStates;

  // Sort by startedAt descending (newest first).
  filtered.sort((a, b) => {
    const ta = new Date(a.startedAt).getTime();
    const tb = new Date(b.startedAt).getTime();
    return tb - ta;
  });

  // Apply --limit.
  const rows = filtered.slice(0, limit);

  // Header.
  process.stdout.write(`${MARK}  recent runs\n`);

  if (rows.length === 0) {
    process.stdout.write('\n');
    process.stdout.write('  no runs yet. start one: relay run <flow> .\n');
    return;
  }

  process.stdout.write('\n');

  for (const state of rows) {
    process.stdout.write(renderRow(state) + '\n');
  }

  process.stdout.write('\n');

  // Footer hint.
  process.stdout.write(gray('resume any: relay resume <runId>') + '\n');
}
