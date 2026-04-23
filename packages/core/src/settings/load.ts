import { readFile } from 'node:fs/promises';
import { err, ok, type Result } from 'neverthrow';
import { ERROR_CODES, PipelineError } from '../errors.js';
import { z } from '../zod.js';
import { flowSettingsPath, globalSettingsPath } from './paths.js';
import { RelaySettings } from './schema.js';

async function loadSettings(
  filePath: string,
): Promise<Result<RelaySettings | null, PipelineError>> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(null);
    }
    return err(
      new PipelineError(
        `failed to read settings file at ${filePath}: ${(e as Error).message}`,
        ERROR_CODES.FLOW_DEFINITION,
      ),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err(
      new PipelineError(
        `settings file at ${filePath} contains invalid JSON: ${(e as Error).message}`,
        ERROR_CODES.FLOW_DEFINITION,
      ),
    );
  }

  const result = RelaySettings.safeParse(parsed);
  if (!result.success) {
    return err(
      new PipelineError(
        `settings file at ${filePath} failed schema validation: ${z.prettifyError(result.error)}`,
        ERROR_CODES.FLOW_DEFINITION,
      ),
    );
  }

  return ok(result.data);
}

export async function loadGlobalSettings(): Promise<Result<RelaySettings | null, PipelineError>> {
  return loadSettings(globalSettingsPath());
}

export async function loadFlowSettings(
  flowDir: string,
): Promise<Result<RelaySettings | null, PipelineError>> {
  return loadSettings(flowSettingsPath(flowDir));
}
