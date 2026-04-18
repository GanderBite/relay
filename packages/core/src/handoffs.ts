import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { HandoffSchemaError } from './errors.js';
import { atomicWriteJson } from './util/atomic-write.js';
import type { z } from './zod.js';

export class HandoffStore {
  readonly #handoffsDir: string;

  constructor(runDir: string) {
    this.#handoffsDir = join(runDir, 'handoffs');
  }

  async write(id: string, value: unknown, schema?: z.ZodType): Promise<void> {
    if (schema !== undefined) {
      const result = schema.safeParse(value);
      if (!result.success) {
        throw new HandoffSchemaError(
          `handoff "${id}" failed schema validation`,
          id,
          result.error.issues,
        );
      }
    }

    const filePath = join(this.#handoffsDir, `${id}.json`);
    const writeResult = await atomicWriteJson(filePath, value);
    if (writeResult.isErr()) {
      throw writeResult.error;
    }
  }

  async read<T = unknown>(id: string, schema?: z.ZodType<T>): Promise<T> {
    const filePath = join(this.#handoffsDir, `${id}.json`);
    const raw = await readFile(filePath, { encoding: 'utf8' });
    const parsed: unknown = JSON.parse(raw);

    if (schema !== undefined) {
      const result = schema.safeParse(parsed);
      if (!result.success) {
        throw new HandoffSchemaError(
          `handoff "${id}" failed schema validation`,
          id,
          result.error.issues,
        );
      }
      return result.data;
    }

    return parsed as T;
  }

  async exists(id: string): Promise<boolean> {
    const filePath = join(this.#handoffsDir, `${id}.json`);
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }

  async list(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(this.#handoffsDir);
    } catch {
      return [];
    }

    return entries
      .filter((name) => name.endsWith('.json'))
      .map((name) => name.slice(0, -'.json'.length))
      .sort();
  }
}
