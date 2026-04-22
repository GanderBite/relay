import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import type { ResultAsync } from 'neverthrow';

import type { AtomicWriteError } from '../errors.js';
import type { RunnerStatus } from '../race/types.js';
import { atomicWriteJson } from '../util/atomic-write.js';

export interface LiveStatePartial {
  status: RunnerStatus;
  attempt: number;
  startedAt: string;
  lastUpdateAt: string;
  model?: string;
  tokensSoFar?: number;
  turnsSoFar?: number;
}

export function writeLiveState(
  runDir: string,
  runnerId: string,
  partial: LiveStatePartial,
): ResultAsync<void, AtomicWriteError> {
  const filePath = join(runDir, 'live', `${runnerId}.json`);
  return atomicWriteJson(filePath, partial);
}

export async function clearLiveDir(runDir: string): Promise<void> {
  const liveDir = join(runDir, 'live');
  await rm(liveDir, { recursive: true, force: true });
}
