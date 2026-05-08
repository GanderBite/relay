/**
 * Per-step event-log writer.
 *
 * Opens an NDJSON file in append mode the first time write() is called and
 * appends one JSON-encoded EventRecord per line. Errors from open, write, and
 * sync are best-effort: they are caught and reported on stderr so a transient
 * I/O fault on the event log never derails the in-flight provider invocation
 * that is producing the events.
 */

import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import type { InvocationEvent } from '../providers/types.js';

export type EventRecord = {
  seq: number;
  ts: string;
  attempt: number;
  event: InvocationEvent;
  raw?: unknown;
};

function stderrMessage(prefix: string, caught: unknown): string {
  const detail = caught instanceof Error ? caught.message : String(caught);
  return `${prefix}: ${detail}\n`;
}

export class EventLogWriter {
  readonly #path: string;
  readonly #attempt: number;
  #handle: FileHandle | null = null;
  #openAttempted = false;

  constructor(eventsDir: string, stepId: string, attempt: number) {
    this.#path = join(eventsDir, `${stepId}.jsonl`);
    this.#attempt = attempt;
  }

  async write(seq: number, event: InvocationEvent, raw?: unknown): Promise<void> {
    if (this.#handle === null && !this.#openAttempted) {
      this.#openAttempted = true;
      try {
        this.#handle = await open(this.#path, 'a');
      } catch (caught) {
        process.stderr.write(stderrMessage('event-log: open failed', caught));
        return;
      }
    }

    const handle = this.#handle;
    if (handle === null) {
      return;
    }

    const record: EventRecord = {
      seq,
      ts: new Date().toISOString(),
      attempt: this.#attempt,
      event,
      ...(raw === undefined ? {} : { raw }),
    };

    try {
      await handle.write(`${JSON.stringify(record)}\n`);
    } catch (caught) {
      process.stderr.write(stderrMessage('event-log: write failed', caught));
    }
  }

  async flush(): Promise<void> {
    const handle = this.#handle;
    if (handle === null) {
      return;
    }
    this.#handle = null;

    try {
      await handle.sync();
    } catch (caught) {
      process.stderr.write(stderrMessage('event-log: sync failed', caught));
    }

    try {
      await handle.close();
    } catch (caught) {
      process.stderr.write(stderrMessage('event-log: close failed', caught));
    }
  }
}
