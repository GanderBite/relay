import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { err, ok, type Result } from 'neverthrow';

import {
  ERROR_CODES,
  PipelineError,
  RaceStateCorruptError,
  RaceStateNotFoundError,
} from '../errors.js';
import type { Race, RaceState } from '../race/types.js';
import { parseWithSchema } from '../util/json.js';
import { z } from '../zod.js';

// On-disk name changed from flow-ref.json (pre-sprint-15) to race-ref.json.
// Runs started before this rename cannot be resumed — re-run from scratch.
const RACE_REF_FILENAME = 'race-ref.json';

export interface RaceRef {
  raceName: string;
  raceVersion: string;
  /**
   * Absolute path to the race module (race.ts/race.js) that defined this run.
   * Persisted when the caller supplied it at run start. Null when the
   * Orchestrator could not derive a path; resume must reject in that case
   * since a fresh process needs a file to re-import.
   */
  racePath: string | null;
}

// Schema is permissive on `racePath`: the field may be missing entirely,
// present-but-null (legitimate null from a write with no path supplied), or a
// string. The version-mismatch check runs before any import attempt, so a
// missing path only becomes fatal when the Runner actually needs to re-import.
interface RaceRefRaw {
  raceName: string;
  raceVersion: string;
  racePath?: string | null;
}

const RaceRefRawSchema: z.ZodType<RaceRefRaw> = z.object({
  raceName: z.string(),
  raceVersion: z.string(),
  racePath: z.string().nullable().optional(),
});

/**
 * Read `<runDir>/race-ref.json`. Returns a typed RaceRef on success, a
 * RaceStateNotFoundError when the file is absent, and RaceStateCorruptError
 * when the contents are unreadable or fail schema validation. The Orchestrator
 * maps these into a PipelineError with a resume-specific message at the call
 * site.
 */
export async function loadRaceRef(
  runDir: string,
): Promise<Result<RaceRef, RaceStateNotFoundError | RaceStateCorruptError>> {
  const filePath = join(runDir, RACE_REF_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: 'utf8' });
  } catch (caught) {
    const code =
      caught instanceof Error && 'code' in caught && typeof caught.code === 'string'
        ? caught.code
        : undefined;
    if (code === 'ENOENT') {
      return err(new RaceStateNotFoundError('race-ref.json not found', runDir));
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(
      new RaceStateCorruptError(`race-ref.json could not be read: ${message}`, { reason: message }),
    );
  }
  const parsed = parseWithSchema(raw, RaceRefRawSchema);
  if (parsed.isErr()) {
    return err(
      new RaceStateCorruptError(`race-ref.json is malformed: ${parsed.error.message}`, {
        reason: parsed.error.message,
      }),
    );
  }
  const rawRef = parsed.value;
  return ok({
    raceName: rawRef.raceName,
    raceVersion: rawRef.raceVersion,
    racePath: rawRef.racePath ?? null,
  });
}

/**
 * Dynamically import the race module at `racePath` and return its Race export.
 * Accepts a module that exports the race as `default` or as a named `race`
 * export; rejects anything else with a clear error so authors know exactly
 * what shape the runtime expects on resume.
 */
export async function importRace(racePath: string): Promise<Race<unknown>> {
  const href = pathToFileURL(racePath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(href)) as Record<string, unknown>;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new PipelineError(
      `resume failed to import race module at "${racePath}": ${message}. ` +
        'Resume requires the race package to be built (run `pnpm build` in the race package before invoking resume).',
      ERROR_CODES.RACE_DEFINITION,
      { racePath, cause: message },
    );
  }
  const candidate = mod['default'] ?? mod['race'];
  if (!isRace(candidate)) {
    throw new PipelineError(
      `race module at "${racePath}" does not export a Race. ` +
        'Export the compiled race as the default export or as a named "race" export in race.ts.',
      ERROR_CODES.RACE_DEFINITION,
      { racePath },
    );
  }
  return candidate;
}

function isRace(value: unknown): value is Race<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['version'] === 'string' &&
    typeof record['runners'] === 'object' &&
    record['runners'] !== null &&
    typeof record['graph'] === 'object' &&
    record['graph'] !== null
  );
}

/**
 * Compute the initial ready queue for a resumed run. A step is "ready" when
 * it is not already succeeded/skipped AND every predecessor is either
 * succeeded, skipped, or failed with onFail=continue. Failed steps that the
 * Runner plans to retry are included — the caller resets their status before
 * the walker dispatches them.
 */
export function seedReadyQueueForResume(
  race: Race<unknown>,
  state: RaceState,
): string[] {
  const queue: string[] = [];
  for (const runnerId of race.graph.topoOrder) {
    const runnerState = state.runners[runnerId];
    if (runnerState === undefined) continue;
    if (runnerState.status === 'succeeded' || runnerState.status === 'skipped') continue;

    const preds = race.graph.predecessors.get(runnerId);
    if (preds === undefined) continue;

    let ready = true;
    for (const p of preds) {
      const predState = state.runners[p];
      const predStatus = predState?.status;
      const pred = race.runners[p];
      const predAllowsContinue =
        pred !== undefined &&
        pred.kind !== 'terminal' &&
        pred.kind !== 'parallel' &&
        pred.onFail === 'continue';
      const okPred =
        predStatus === 'succeeded' ||
        predStatus === 'skipped' ||
        (predStatus === 'failed' && predAllowsContinue);
      if (!okPred) {
        ready = false;
        break;
      }
    }
    if (ready) queue.push(runnerId);
  }
  return queue;
}
