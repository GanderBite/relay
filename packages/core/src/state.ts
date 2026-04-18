import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PipelineError } from './errors.js';
import type { RunState, RunStatus, StepState } from './flow/types.js';
import { atomicWriteJson } from './util/atomic-write.js';

const STATE_FILENAME = 'state.json';

function nowIso(): string {
  return new Date().toISOString();
}

function illegalTransition(stepId: string, attempted: string, from: string): PipelineError {
  return new PipelineError(
    `step "${stepId}": illegal transition — cannot ${attempted} from status "${from}"`,
    'relay_STATE_TRANSITION',
    { stepId, attempted, from },
  );
}

function unknownStep(stepId: string): PipelineError {
  return new PipelineError(
    `step "${stepId}": not registered in run state; call init() first`,
    'relay_STATE_UNKNOWN_STEP',
    { stepId },
  );
}

export class StateMachine {
  readonly #runDir: string;
  #state: RunState;

  constructor(runDir: string, flowName: string, flowVersion: string, runId: string, input: unknown) {
    this.#runDir = runDir;
    const startedAt = nowIso();
    this.#state = {
      runId,
      flowName,
      flowVersion,
      startedAt,
      updatedAt: startedAt,
      input,
      steps: {},
      status: 'running',
    };
  }

  get state(): RunState {
    return this.#state;
  }

  get runDir(): string {
    return this.#runDir;
  }

  async init(steps: string[]): Promise<void> {
    const seeded: Record<string, StepState> = {};
    for (const id of steps) {
      seeded[id] = { status: 'pending', attempts: 0 };
    }
    this.#state = { ...this.#state, steps: seeded, updatedAt: nowIso() };
    await this.save();
  }

  async startStep(id: string): Promise<void> {
    const step = this.#requireStep(id);
    if (step.status !== 'pending') {
      throw illegalTransition(id, 'start', step.status);
    }
    this.#updateStep(id, {
      ...step,
      status: 'running',
      startedAt: nowIso(),
      attempts: step.attempts + 1,
    });
    await this.save();
  }

  async completeStep(id: string, artifacts?: string[], handoffs?: string[]): Promise<void> {
    const step = this.#requireStep(id);
    if (step.status !== 'running') {
      throw illegalTransition(id, 'complete', step.status);
    }
    const next: StepState = {
      ...step,
      status: 'succeeded',
      completedAt: nowIso(),
    };
    if (artifacts !== undefined) next.artifacts = artifacts;
    if (handoffs !== undefined) next.handoffs = handoffs;
    this.#updateStep(id, next);
    await this.save();
  }

  async failStep(id: string, errorMessage: string): Promise<void> {
    const step = this.#requireStep(id);
    if (step.status !== 'running') {
      throw illegalTransition(id, 'fail', step.status);
    }
    this.#updateStep(id, {
      ...step,
      status: 'failed',
      completedAt: nowIso(),
      errorMessage,
    });
    this.#state = { ...this.#state, status: 'failed', updatedAt: nowIso() };
    await this.save();
  }

  async skipStep(id: string): Promise<void> {
    const step = this.#requireStep(id);
    if (step.status !== 'pending') {
      throw illegalTransition(id, 'skip', step.status);
    }
    this.#updateStep(id, { ...step, status: 'skipped' });
    await this.save();
  }

  async markRun(status: RunStatus): Promise<void> {
    this.#state = { ...this.#state, status, updatedAt: nowIso() };
    await this.save();
  }

  async load(): Promise<RunState> {
    const loaded = await loadState(this.#runDir);
    this.#state = loaded;
    return loaded;
  }

  // Every mutation ends in save() so a crash leaves state.json consistent with the last
  // transition the caller observed — atomic rename keeps concurrent readers torn-free.
  async save(): Promise<void> {
    const result = await atomicWriteJson(join(this.#runDir, STATE_FILENAME), this.#state);
    if (result.isErr()) {
      throw result.error;
    }
  }

  #requireStep(id: string): StepState {
    const step = this.#state.steps[id];
    if (step === undefined) {
      throw unknownStep(id);
    }
    return step;
  }

  #updateStep(id: string, next: StepState): void {
    this.#state = {
      ...this.#state,
      steps: { ...this.#state.steps, [id]: next },
      updatedAt: nowIso(),
    };
  }
}

export async function loadState(runDir: string): Promise<RunState> {
  const raw = await readFile(join(runDir, STATE_FILENAME), { encoding: 'utf8' });
  return JSON.parse(raw) as RunState;
}

export function verifyCompatibility(
  state: RunState,
  flowName: string,
  flowVersion: string,
): void {
  if (state.flowName !== flowName || state.flowVersion !== flowVersion) {
    throw new PipelineError(
      `run state is not compatible with this flow: expected ${flowName}@${flowVersion}, found ${state.flowName}@${state.flowVersion}. Start a new run.`,
      'relay_STATE_INCOMPATIBLE',
      {
        expected: { flowName, flowVersion },
        actual: { flowName: state.flowName, flowVersion: state.flowVersion },
      },
    );
  }
}
