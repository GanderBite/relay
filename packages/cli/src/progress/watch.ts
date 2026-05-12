/**
 * File watcher for the Relay live-state and events directories.
 *
 * Watches live/<step>.json files via chokidar and, when verbose=true, tails
 * events/<step>.jsonl files using a byte-offset approach. Emits typed WatchEvent
 * values to a caller-supplied callback.
 *
 * Events tailing: on each chokidar add/change event only the newly-appended
 * bytes are read from the events file, framed into complete NDJSON lines, and
 * validated with EventRecordSchema.safeParse. The per-step offset and partial-line
 * buffer are maintained in per-step TailState entries.
 *
 * stop() closes the events watcher before draining in-flight tail reads, ensuring
 * the final flush from EventLogWriter is captured.
 */

import type { FileHandle } from 'node:fs/promises';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ReplayedEventRecord } from '@ganderbite/relay-core';
import { EventRecordSchema } from '@ganderbite/relay-core';
import type { LiveStatePartial } from '@ganderbite/relay-core/live-state';
import type { FSWatcher } from 'chokidar';
import { watch } from 'chokidar';
import { LiveStatePartialSchema } from '../schemas.js';

// ---------------------------------------------------------------------------
// WatchEvent discriminated union
// ---------------------------------------------------------------------------

/** Emitted when a live/<step>.json file changes. */
export interface LiveStateEvent {
  kind: 'state';
  stepId: string;
  state: LiveStatePartial;
}

/** Emitted when a new EventRecord is parsed from an events/<step>.jsonl file. */
export interface EventsRecordEvent {
  kind: 'events';
  stepId: string;
  records: ReplayedEventRecord[];
}

export type WatchEvent = LiveStateEvent | EventsRecordEvent;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface TailState {
  offset: number;
  partial: string;
  decoder: StringDecoder;
}

// ---------------------------------------------------------------------------
// Watcher handle
// ---------------------------------------------------------------------------

export interface WatcherHandle {
  stop: () => Promise<void>;
}

// ---------------------------------------------------------------------------
// startWatcher
// ---------------------------------------------------------------------------

/**
 * Start watching the live-state and (optionally) events directories in runDir.
 *
 * @param runDir   Path to the .relay/runs/<runId> directory.
 * @param onEvent  Callback invoked for each WatchEvent.
 * @param verbose  When true, also tail events/<step>.jsonl files.
 * @param stepIds  Set of valid step IDs; events for unknown steps are ignored.
 * @returns        A handle with a stop() method that drains and closes watchers.
 */
export function startWatcher(
  runDir: string,
  onEvent: (e: WatchEvent) => void,
  verbose: boolean,
  stepIds: ReadonlySet<string>,
): WatcherHandle {
  const liveDir = join(runDir, 'live');

  // Watch the directory itself, not a glob. On macOS the chokidar FSEvents
  // backend fires zero events for a `dir/*.json` glob pattern — the directory
  // watch is the only form that works reliably.
  const liveWatcher: FSWatcher = watch(liveDir, {
    persistent: true,
    ignoreInitial: false,
    awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
  });

  const onLiveFileChange = (filePath: string): void => {
    if (!filePath.endsWith('.json')) return;
    void loadLiveFile(filePath, stepIds, onEvent);
  };

  liveWatcher.on('add', onLiveFileChange);
  liveWatcher.on('change', onLiveFileChange);

  // Per-step tail state for byte-offset reading of events files.
  const tailStates = new Map<string, TailState>();
  // Tracks the most recent in-flight tail promise per step so stop() can await it.
  const inFlightTail = new Map<string, Promise<void>>();

  let eventsWatcher: FSWatcher | null = null;

  if (verbose) {
    const eventsDir = join(runDir, 'events');
    eventsWatcher = watch(eventsDir, {
      persistent: true,
      ignoreInitial: false,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 20 },
    });

    const onEventsFileChange = (filePath: string): void => {
      if (!filePath.endsWith('.jsonl')) return;
      const stepId = stepIdFromPath(filePath);
      if (!stepIds.has(stepId)) return;

      // Chain onto the previous in-flight promise for this step so concurrent
      // watcher events serialize correctly.
      const previous = inFlightTail.get(stepId) ?? Promise.resolve();
      const next = previous.then(() => doTailEventsFile(filePath, stepId, tailStates, onEvent));
      inFlightTail.set(stepId, next);
      // Swallow the error so the chain never rejects and stop() can await it.
      void next.catch(() => undefined);
    };

    eventsWatcher.on('add', onEventsFileChange);
    eventsWatcher.on('change', onEventsFileChange);
  }

  const stop = async (): Promise<void> => {
    // Close the live watcher.
    void liveWatcher.close();

    // Close the events watcher FIRST so no new tail promises can be enqueued,
    // then drain whatever is already in inFlightTail.
    if (eventsWatcher !== null) {
      await eventsWatcher.close();
    }
    const pending = Array.from(inFlightTail.values());
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
  };

  return { stop };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stepIdFromPath(filePath: string): string {
  const basename = filePath.split('/').at(-1) ?? filePath.split('\\').at(-1) ?? '';
  return basename.replace(/\.(json|jsonl)$/, '');
}

async function loadLiveFile(
  filePath: string,
  stepIds: ReadonlySet<string>,
  onEvent: (e: WatchEvent) => void,
): Promise<void> {
  const stepId = stepIdFromPath(filePath);
  if (!stepIds.has(stepId)) return;

  let parsed: LiveStatePartial;
  try {
    const raw = await readFile(filePath, 'utf8');
    const result = LiveStatePartialSchema.safeParse(JSON.parse(raw));
    if (!result.success) return;
    const d = result.data;
    parsed = {
      status: d.status,
      attempt: d.attempt,
      startedAt: d.startedAt,
      lastUpdateAt: d.lastUpdateAt,
      ...(d.model !== undefined ? { model: d.model } : {}),
      ...(d.tokensSoFar !== undefined ? { tokensSoFar: d.tokensSoFar } : {}),
      ...(d.toolsSoFar !== undefined ? { toolsSoFar: d.toolsSoFar } : {}),
      ...(d.iter !== undefined ? { iter: d.iter } : {}),
      ...(d.maxIter !== undefined ? { maxIter: d.maxIter } : {}),
      ...(d.branchCount !== undefined ? { branchCount: d.branchCount } : {}),
    };
  } catch {
    // File read race or JSON parse failure — skip; next event will retry.
    return;
  }

  onEvent({ kind: 'state', stepId, state: parsed });
}

async function doTailEventsFile(
  filePath: string,
  stepId: string,
  tailStates: Map<string, TailState>,
  onEvent: (e: WatchEvent) => void,
): Promise<void> {
  // Lazy-allocate tail state for this step.
  let tail = tailStates.get(stepId);
  if (tail === undefined) {
    tail = { offset: 0, partial: '', decoder: new StringDecoder('utf8') };
    tailStates.set(stepId, tail);
  }

  // Open the file and read from the current offset to EOF.
  let handle: FileHandle | null = null;
  try {
    handle = await open(filePath, 'r');
  } catch {
    // File not yet available — skip; next change event will retry.
    return;
  }

  let chunk: Buffer;
  try {
    const stat = await handle.stat();
    const fileSize = stat.size;
    if (fileSize <= tail.offset) {
      // No new bytes — nothing to do.
      return;
    }
    const toRead = fileSize - tail.offset;
    chunk = Buffer.allocUnsafe(toRead);
    const { bytesRead } = await handle.read(chunk, 0, toRead, tail.offset);
    tail.offset += bytesRead;
    chunk = chunk.subarray(0, bytesRead);
  } catch {
    return;
  } finally {
    try {
      await handle?.close();
    } catch {
      // best-effort close
    }
  }

  // Frame the chunk into complete lines, preserving the partial buffer.
  // StringDecoder.write() buffers trailing partial multi-byte sequences
  // so that a chokidar event firing mid-codepoint cannot produce replacement
  // characters in the decoded output.
  const text = tail.partial + tail.decoder.write(chunk);
  const newlineIndex = text.lastIndexOf('\n');
  if (newlineIndex === -1) {
    tail.partial = text;
    return;
  }

  tail.partial = text.slice(newlineIndex + 1);
  const completeText = text.slice(0, newlineIndex);
  const newRecords: ReplayedEventRecord[] = [];

  for (const line of completeText.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Malformed JSON — skip.
      continue;
    }

    const result = EventRecordSchema.safeParse(parsed);
    if (!result.success) {
      // Malformed record — skip without throwing.
      continue;
    }

    newRecords.push(result.data);
  }

  if (newRecords.length > 0) {
    onEvent({ kind: 'events', stepId, records: newRecords });
  }
}
