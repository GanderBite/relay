import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { err, ok, type Result } from 'neverthrow';

import {
  ERROR_CODES,
  PipelineError,
  StateCorruptError,
  StateNotFoundError,
} from '../errors.js';
import type { Flow, RunState } from '../flow/types.js';
import { parseWithSchema } from '../util/json.js';
import { z } from '../zod.js';

const FLOW_REF_FILENAME = 'flow-ref.json';

export interface FlowRef {
  flowName: string;
  flowVersion: string;
  /**
   * Absolute path to the flow module (flow.ts/flow.js) that defined this run.
   * Persisted when the caller supplied it at run start. Null when the Runner
   * could not derive a path; resume must reject in that case since a fresh
   * process needs a file to re-import.
   */
  flowPath: string | null;
}

// Schema is permissive on `flowPath`: the field may be missing entirely,
// present-but-null (legitimate null from a write with no path supplied), or a
// string. The version-mismatch check runs before any import attempt, so a
// missing path only becomes fatal when the Runner actually needs to re-import.
interface FlowRefRaw {
  flowName: string;
  flowVersion: string;
  flowPath?: string | null;
}

const FlowRefRawSchema: z.ZodType<FlowRefRaw> = z.object({
  flowName: z.string(),
  flowVersion: z.string(),
  flowPath: z.string().nullable().optional(),
});

/**
 * Read `<runDir>/flow-ref.json`. Returns a typed FlowRef on success, a
 * StateNotFoundError when the file is absent, and StateCorruptError when the
 * contents are unreadable or fail schema validation. The Runner maps these
 * into a PipelineError with a resume-specific message at the call site.
 */
export async function loadFlowRef(
  runDir: string,
): Promise<Result<FlowRef, StateNotFoundError | StateCorruptError>> {
  const filePath = join(runDir, FLOW_REF_FILENAME);
  let raw: string;
  try {
    raw = await readFile(filePath, { encoding: 'utf8' });
  } catch (caught) {
    const code =
      caught instanceof Error && 'code' in caught && typeof caught.code === 'string'
        ? caught.code
        : undefined;
    if (code === 'ENOENT') {
      return err(new StateNotFoundError('flow-ref.json not found', runDir));
    }
    const message = caught instanceof Error ? caught.message : String(caught);
    return err(
      new StateCorruptError(`flow-ref.json could not be read: ${message}`, { reason: message }),
    );
  }
  const parsed = parseWithSchema(raw, FlowRefRawSchema);
  if (parsed.isErr()) {
    return err(
      new StateCorruptError(`flow-ref.json is malformed: ${parsed.error.message}`, {
        reason: parsed.error.message,
      }),
    );
  }
  const rawRef = parsed.value;
  return ok({
    flowName: rawRef.flowName,
    flowVersion: rawRef.flowVersion,
    flowPath: rawRef.flowPath ?? null,
  });
}

/**
 * Dynamically import the flow module at `flowPath` and return its Flow export.
 * Accepts a module that exports the flow as `default` or as a named `flow`
 * export; rejects anything else with a clear error so authors know exactly
 * what shape the runtime expects on resume.
 */
export async function importFlow(flowPath: string): Promise<Flow<unknown>> {
  const href = pathToFileURL(flowPath).href;
  let mod: Record<string, unknown>;
  try {
    mod = (await import(href)) as Record<string, unknown>;
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    throw new PipelineError(
      `resume failed to import flow module at "${flowPath}": ${message}. ` +
        'Resume requires the flow package to be built (run `pnpm build` in the flow package before invoking resume).',
      ERROR_CODES.FLOW_DEFINITION,
      { flowPath, cause: message },
    );
  }
  const candidate = mod['default'] ?? mod['flow'];
  if (!isFlow(candidate)) {
    throw new PipelineError(
      `flow module at "${flowPath}" does not export a Flow. ` +
        'Export the compiled flow as the default export or as a named "flow" export in flow.ts.',
      ERROR_CODES.FLOW_DEFINITION,
      { flowPath },
    );
  }
  return candidate;
}

function isFlow(value: unknown): value is Flow<unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['name'] === 'string' &&
    typeof record['version'] === 'string' &&
    typeof record['steps'] === 'object' &&
    record['steps'] !== null &&
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
  flow: Flow<unknown>,
  state: RunState,
): string[] {
  const queue: string[] = [];
  for (const stepId of flow.graph.topoOrder) {
    const stepState = state.steps[stepId];
    if (stepState === undefined) continue;
    if (stepState.status === 'succeeded' || stepState.status === 'skipped') continue;

    const preds = flow.graph.predecessors.get(stepId);
    if (preds === undefined) continue;

    let ready = true;
    for (const p of preds) {
      const predState = state.steps[p];
      const predStatus = predState?.status;
      const pred = flow.steps[p];
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
    if (ready) queue.push(stepId);
  }
  return queue;
}
