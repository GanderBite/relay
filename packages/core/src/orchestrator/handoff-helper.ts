import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';

import type { AtomicWriteError } from '../errors.js';
import { atomicWriteText } from '../util/atomic-write.js';
import { renderHandoffHelperScript } from './handoff-helper-template.js';

export interface WriteHandoffHelperArgs {
  /** Absolute path to the run directory the script will live under. */
  runDir: string;
  /** Map of handoff id → JSON Schema. Empty maps are valid (no schema-bound steps). */
  schemasById: Record<string, unknown>;
  /** Absolute path the script should write validated handoff files into. */
  handoffsDir: string;
}

/**
 * Writes the per-run handoff helper script to `<runDir>/.bin/handoff.mjs`.
 * The script is invoked through `node`, so the `chmod` is best-effort —
 * Windows file systems that reject 0o755 still leave a runnable file behind
 * because the model uses `node <path>` to execute it, never bare execution.
 */
export async function writeHandoffHelperScript(
  args: WriteHandoffHelperArgs,
): Promise<Result<string, AtomicWriteError>> {
  const scriptPath = join(args.runDir, '.bin', 'handoff.mjs');
  const source = renderHandoffHelperScript({
    schemasById: args.schemasById,
    runDir: args.runDir,
    handoffsDir: args.handoffsDir,
  });
  const writeResult = await atomicWriteText(scriptPath, source);
  if (writeResult.isErr()) return err(writeResult.error);
  try {
    await chmod(scriptPath, 0o755);
  } catch {
    // chmod failure is non-fatal — the model invokes the file through `node`.
  }
  return ok(scriptPath);
}
