/**
 * Cross-process atomic-write integrity test.
 *
 * Spawns 10 concurrent child processes, each calling atomicWriteJson (from the
 * built dist) to write a distinct JSON payload to the SAME output path.
 * Because atomicWriteJson uses write-to-tmp + fsync + rename(2), exactly one
 * writer wins each race and the file is always valid, complete JSON — never a
 * torn or partial write from interleaved concurrent writes.
 *
 * The race is repeated 3 times to increase the probability of hitting the
 * narrow window where the rename contention is observable.
 *
 * Child-process resolution strategy:
 *   Each child is a plain .mjs shim written to the temp dir. The shim imports
 *   atomicWriteJson from the absolute path to the pre-built dist/index.js of
 *   @ganderbite/relay-core. This avoids TypeScript compilation in the child and
 *   avoids relying on workspace package resolution from an arbitrary temp dir.
 *   The shim receives two argv arguments: <payloadJson> and <outPath>.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Absolute path to the pre-built dist bundle. This path is stable within the
// monorepo and is the same file vitest itself loads when importing from the
// package under test.
const DIST_INDEX = resolve(__dirname, '../../dist/index.js');

// Number of concurrent writers per race iteration.
const CONCURRENT_WRITERS = 10;

// Number of race iterations to improve coverage of the contention window.
const RACE_ITERATIONS = 3;

/**
 * Content of the child shim. Parameterised at write-time with the absolute
 * dist path so the shim file is self-contained (no path resolution at
 * child-spawn time).
 */
function shimContent(distIndexPath: string): string {
  return `import { atomicWriteJson } from '${distIndexPath}';
const [, , payloadJson, outPath] = process.argv;
const value = JSON.parse(payloadJson);
const r = await atomicWriteJson(outPath, value);
if (r.isErr()) {
  process.stderr.write('atomicWriteJson failed: ' + r.error.message + '\\n');
  process.exit(1);
}
`;
}

/**
 * Spawn a single child process running the shim with the given payload and
 * output path. Returns a Promise that resolves to the child's exit code.
 */
function spawnWriter(shimPath: string, payload: object, outPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [shimPath, JSON.stringify(payload), outPath], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      const exitCode = code ?? 1;
      if (exitCode !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString('utf8').trim();
        reject(new Error(`Child exited ${exitCode}: ${stderr}`));
      } else {
        resolve(exitCode);
      }
    });
  });
}

describe('cross-process handoff atomicity', () => {
  let tmp: string;
  let shimPath: string;
  let outPath: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-xp-'));
    shimPath = join(tmp, 'writer-shim.mjs');
    outPath = join(tmp, 'handoff.json');
    await writeFile(shimPath, shimContent(DIST_INDEX), 'utf8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it(`[XP-001] ${CONCURRENT_WRITERS} concurrent writers produce valid JSON after ${RACE_ITERATIONS} iterations`, async () => {
    for (let iteration = 0; iteration < RACE_ITERATIONS; iteration++) {
      // Build payload objects — each writer includes its index and iteration
      // so the winning payload is identifiable in assertion output.
      const payloads = Array.from({ length: CONCURRENT_WRITERS }, (_, i) => ({
        iteration,
        writer: i,
        data: `payload-${iteration}-${i}`,
      }));

      // Launch all writers concurrently. Promise.all rejects immediately if
      // any child exits non-zero, which surfaces stderr from that child.
      const exitCodes = await Promise.all(
        payloads.map((payload) => spawnWriter(shimPath, payload, outPath)),
      );

      // Every child must exit 0.
      for (const code of exitCodes) {
        expect(code).toBe(0);
      }

      // The file must exist and contain valid JSON after all writers settle.
      const raw = await readFile(outPath, 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();

      // The JSON must be one of the payloads that was written — not a merge
      // of two concurrent writes (which would produce invalid JSON).
      const parsed: unknown = JSON.parse(raw);
      expect(parsed).toMatchObject({
        iteration,
        writer: expect.any(Number),
        data: expect.stringMatching(/^payload-\d+-\d+$/),
      });
    }
  }, 30_000); // Allow 30 s: 3 iterations × 10 spawns, each spawn takes ~50-200 ms on CI.

  it('[XP-002] no .tmp-* files remain after all writers settle', async () => {
    const payloads = Array.from({ length: CONCURRENT_WRITERS }, (_, i) => ({
      writer: i,
    }));

    await Promise.all(payloads.map((p) => spawnWriter(shimPath, p, outPath)));

    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(tmp);
    const tmpFiles = entries.filter((e) => e.includes('.tmp-'));
    expect(tmpFiles).toHaveLength(0);
  });
});
