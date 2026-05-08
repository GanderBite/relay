/**
 * Per-step event-log writer.
 *
 * Opens an NDJSON file in append mode the first time write() is called and
 * appends one JSON-encoded EventRecord per line. Errors from open, write, and
 * sync are best-effort: they are caught and reported through the project
 * logger when one is supplied (so failures surface on the per-run NDJSON
 * channel) or written to stderr as a fallback. The writer never propagates
 * errors back to the caller — a transient I/O fault on the event log must
 * never derail the in-flight provider invocation that is producing the events.
 *
 * Disk writes are queued through a single in-flight promise chain so the
 * provider stream is never gated on per-event syscalls; flush() drains the
 * queue before the trailing fsync to guarantee all queued bytes hit disk.
 */

import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { Logger } from '../logger.js';
import type { InvocationEvent } from '../providers/types.js';
import { z } from '../zod.js';

/**
 * On-disk shape for the error field in a stream.error record.
 * Error.message, .name, and .stack are non-enumerable on Error subclasses
 * and are therefore omitted by JSON.stringify. This type names the fields
 * explicitly extracted before serialization so the reader always finds them.
 */
export type SerializedStreamError = {
  message: string;
  name: string;
  code?: string;
  details?: unknown;
};

/**
 * An on-disk InvocationEvent variant where stream.error carries a plain
 * SerializedStreamError instead of a PipelineError instance. All other
 * members of the union are unchanged.
 *
 * @internal kept for backward compatibility with EventLogWriter serialization
 */
type SerializableInvocationEvent =
  | Exclude<InvocationEvent, { type: 'stream.error' }>
  | { type: 'stream.error'; error: SerializedStreamError };

/**
 * Normalize an InvocationEvent before JSON.stringify. When the event is a
 * stream.error, the error field is a PipelineError whose non-enumerable
 * properties (message, name) are not serialized by default. This helper
 * returns a new event object with those fields extracted into a plain object.
 * All other event types are returned unchanged.
 */
function normalizeForSerialization(event: InvocationEvent): SerializableInvocationEvent {
  if (event.type !== 'stream.error') {
    return event;
  }
  const err = event.error;
  const code = 'code' in err && typeof err.code === 'string' ? err.code : undefined;
  const details = 'details' in err ? err.details : undefined;
  const serializedError: SerializedStreamError = {
    message: err.message,
    name: err.name,
    ...(code !== undefined ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
  return { type: 'stream.error', error: serializedError };
}

export type EventRecord = {
  seq: number;
  ts: string;
  attempt: number;
  event: InvocationEvent;
  raw?: unknown;
};

/**
 * Zod schema for replayed event records — validates NDJSON lines read from
 * events/*.jsonl. Mirrors the InvocationEvent discriminated union from
 * providers/types.ts, except stream.error carries a structured plain-object
 * shape (SerializedStreamError) rather than a PipelineError instance, which
 * is never preserved after JSON round-trip.
 *
 * ReplayedEventRecord and ReplayedInvocationEvent are derived from this
 * schema via z.infer so the schema is the single source of truth.
 *
 * Uses safeParse so a malformed line is skipped without throwing.
 */
export const EventRecordSchema = z.object({
  seq: z.number(),
  ts: z.string(),
  attempt: z.number(),
  event: z.discriminatedUnion('type', [
    z.object({ type: z.literal('turn.start'), turn: z.number() }),
    z.object({ type: z.literal('text.delta'), delta: z.string() }),
    z.object({
      type: z.literal('tool.call'),
      name: z.string(),
      input: z.unknown().optional(),
      toolUseId: z.string().optional(),
    }),
    z.object({
      type: z.literal('tool.result'),
      name: z.string(),
      ok: z.boolean(),
      toolUseId: z.string().optional(),
    }),
    z.object({
      type: z.literal('usage'),
      usage: z.object({
        inputTokens: z.number().optional(),
        outputTokens: z.number().optional(),
        cacheReadTokens: z.number().optional(),
        cacheCreationTokens: z.number().optional(),
      }),
    }),
    z.object({ type: z.literal('turn.end'), turn: z.number() }),
    z.object({
      type: z.literal('stream.end'),
      stopReason: z.string(),
      costUsd: z.number().optional(),
      sessionId: z.string().optional(),
    }),
    z.object({
      type: z.literal('stream.error'),
      error: z.object({
        message: z.string(),
        name: z.string(),
        code: z.string().optional(),
        details: z.unknown().optional(),
      }),
    }),
    z.object({
      type: z.literal('system.init'),
      model: z.string().optional(),
      sessionId: z.string().optional(),
      tools: z.array(z.string()).optional(),
      mcpServers: z.array(z.string()).optional(),
    }),
  ]),
  raw: z.unknown().optional(),
});

/**
 * The on-disk shape of an event record after round-tripping through
 * JSON.stringify / JSON.parse. Derived from EventRecordSchema so the schema
 * is the single source of truth. stream.error carries SerializedStreamError
 * (a plain object), not a PipelineError instance. Use this type wherever
 * records come from EventRecordSchema.safeParse.
 */
export type ReplayedEventRecord = z.infer<typeof EventRecordSchema>;

/**
 * The on-disk InvocationEvent variant derived from EventRecordSchema — the
 * event field of ReplayedEventRecord. stream.error carries a plain
 * SerializedStreamError, not a PipelineError instance.
 */
export type ReplayedInvocationEvent = ReplayedEventRecord['event'];

function stderrMessage(prefix: string, caught: unknown): string {
  const detail = caught instanceof Error ? caught.message : String(caught);
  return `${prefix}: ${detail}\n`;
}

function detailOf(caught: unknown): string {
  return caught instanceof Error ? caught.message : String(caught);
}

export class EventLogWriter {
  readonly #path: string;
  readonly #stepId: string;
  readonly #attempt: number;
  readonly #logger: Logger | undefined;
  #handle: FileHandle | null = null;
  #openAttempted = false;
  // Single in-flight promise chain. Each write() enqueues onto this chain so
  // disk I/O serializes in submission order without blocking the caller. The
  // chain itself never rejects — every step catches its own errors — so a
  // failed write does not stall subsequent ones.
  #queue: Promise<void> = Promise.resolve();

  constructor(eventsDir: string, stepId: string, attempt: number, logger?: Logger) {
    this.#path = join(eventsDir, `${stepId}.jsonl`);
    this.#stepId = stepId;
    this.#attempt = attempt;
    this.#logger = logger;
  }

  #report(phase: 'open' | 'write' | 'sync' | 'close', caught: unknown): void {
    try {
      if (this.#logger !== undefined) {
        this.#logger.warn(
          {
            event: `event-log.${phase}_failed`,
            stepId: this.#stepId,
            attempt: this.#attempt,
            error: detailOf(caught),
          },
          `event-log ${phase} failed; continuing`,
        );
        return;
      }
      process.stderr.write(stderrMessage(`event-log: ${phase} failed`, caught));
    } catch {
      // best-effort logging cannot poison the write queue
    }
  }

  write(seq: number, event: InvocationEvent, raw?: unknown): Promise<void> {
    // Snapshot the timestamp at enqueue time so the recorded ts reflects when
    // the event was observed by the executor, not when the write drained.
    const ts = new Date().toISOString();
    this.#queue = this.#queue.then(() => this.#doWrite(seq, ts, event, raw));
    return Promise.resolve();
  }

  async #doWrite(seq: number, ts: string, event: InvocationEvent, raw?: unknown): Promise<void> {
    if (this.#handle === null && !this.#openAttempted) {
      this.#openAttempted = true;
      try {
        this.#handle = await open(this.#path, 'a');
      } catch (caught) {
        this.#report('open', caught);
        return;
      }
    }

    const handle = this.#handle;
    if (handle === null) {
      return;
    }

    // Normalize stream.error events before serialization. Error.message and
    // Error.name are non-enumerable on Error subclasses and would be omitted
    // by JSON.stringify, leaving the on-disk record without a message field
    // that the schema requires. normalizeForSerialization extracts them into
    // a plain object so the reader always finds a well-formed record.
    const normalizedEvent = normalizeForSerialization(event);
    const record: {
      seq: number;
      ts: string;
      attempt: number;
      event: SerializableInvocationEvent;
      raw?: unknown;
    } = {
      seq,
      ts,
      attempt: this.#attempt,
      event: normalizedEvent,
      ...(raw === undefined ? {} : { raw }),
    };

    try {
      await handle.write(`${JSON.stringify(record)}\n`);
    } catch (caught) {
      this.#report('write', caught);
      // Fallback: preserve the seq/ts/attempt skeleton even when the original
      // payload is unserializable (circular references, BigInt) or the write
      // failed mid-record. Readers of the .jsonl never lose ordering — they
      // see a header-only line tagged _serialization: 'failed'. The fallback
      // write itself is wrapped so a second failure is swallowed silently.
      const fallback = {
        seq,
        ts,
        attempt: this.#attempt,
        event: { type: event.type },
        _serialization: 'failed',
      };
      try {
        await handle.write(`${JSON.stringify(fallback)}\n`);
      } catch {
        /* swallow — best-effort logging cannot fail the caller */
      }
    }
  }

  async flush(): Promise<void> {
    // Drain queued writes BEFORE we sync/close — otherwise queued bytes might
    // sit in node's libuv buffer when the handle closes and never reach disk.
    await this.#queue;

    const handle = this.#handle;
    if (handle === null) {
      return;
    }
    this.#handle = null;

    try {
      await handle.sync();
    } catch (caught) {
      this.#report('sync', caught);
    }

    try {
      await handle.close();
    } catch (caught) {
      this.#report('close', caught);
    }
  }
}
