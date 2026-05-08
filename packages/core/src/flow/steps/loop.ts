import { FlowDefinitionError, toFlowDefError } from '../../errors.js';
import type { StepBuilderOutput } from '../define.js';
import { loopStepSpecSchema } from '../schemas.js';
import type { LoopStepSpec, Step } from '../types.js';

/**
 * The shape returned by the loop builder before the flow compiler assigns an
 * id. `bodyGraph` is undefined — the graph compiler populates it after the
 * outer flow graph is resolved.
 */
export type LoopStepBuilderOutput = Omit<LoopStepSpec, 'id'> & { kind: 'loop' };

/**
 * Input shape for the loop builder. The `body` field accepts builder outputs
 * (without `id`) rather than compiled `Step` values — the builder injects ids
 * from the record keys. `id`, `kind`, and `bodyGraph` are excluded: `id` comes
 * from the flow record key, `kind` is injected by this builder, and `bodyGraph`
 * is filled in by the graph compiler.
 *
 * Nested loops are excluded from the body type so the compiler rejects them at
 * the call site rather than relying on a runtime kind check.
 */
export type LoopStepBuilderInput = Omit<LoopStepSpec, 'id' | 'kind' | 'bodyGraph'> & {
  body: Record<string, Exclude<StepBuilderOutput, LoopStepBuilderOutput>>;
};

/**
 * Synthesise a single `Step` from a builder output by injecting the id.
 * The exhaustive switch keeps the return type precise without a cast.
 */
function synthesizeBodyStep(
  raw: Exclude<StepBuilderOutput, LoopStepBuilderOutput>,
  id: string,
): Step {
  switch (raw.kind) {
    case 'prompt':
      return { ...raw, id };
    case 'script':
      return { ...raw, id };
    case 'branch':
      return { ...raw, id };
    case 'parallel':
      return { ...raw, id };
    case 'terminal':
      return { ...raw, id };
  }
}

/**
 * Compile body builder outputs into Steps by injecting the record key as each
 * step's `id`.
 */
function compileBodySteps(
  body: Record<string, Exclude<StepBuilderOutput, LoopStepBuilderOutput>>,
): Record<string, Step> {
  const compiled: Record<string, Step> = {};
  for (const key of Object.keys(body)) {
    const raw = body[key];
    if (raw === undefined) continue;
    compiled[key] = synthesizeBodyStep(raw, key);
  }
  return compiled;
}

/**
 * Build a loop step spec. Throws `FlowDefinitionError` synchronously when the
 * config fails validation — step builders are load-time programmer-error
 * validators, not runtime fallible operations.
 *
 * Validation performed:
 * - `body` must be non-empty.
 * - No body step may have `kind === 'parallel'` (parallel inside a loop body
 *   is not supported in this version — the dispatch path looks up step ids in
 *   `flow.steps`, but body step ids live only in the loop's `body` map).
 * - Body prompt/script/branch steps must not declare `maxRetries` or
 *   `timeoutMs`. The loop iteration cycle is the recovery boundary, so per-
 *   step retry/timeout fields would be silently ignored at runtime.
 * - `until.from` must match the `output.handoff` of at least one prompt step
 *   in the body.
 * - `maxIterations` must be a positive integer.
 * - The assembled spec must pass the loopStepSpecSchema parse.
 */
export function loopStep(spec: LoopStepBuilderInput): LoopStepBuilderOutput {
  const bodyKeys = Object.keys(spec.body);

  if (bodyKeys.length === 0) {
    throw new FlowDefinitionError('loop step body must not be empty');
  }

  for (const key of bodyKeys) {
    const s = spec.body[key];
    if (s === undefined) continue;
    if (s.kind === 'parallel') {
      throw new FlowDefinitionError(
        'loop step body must not contain parallel steps (step.parallel inside a body is not supported in this version)',
      );
    }

    // Body steps re-use the parent loop's iteration cycle as their recovery
    // boundary — per-step retry and timeout fields are not honored on body
    // steps. Reject them at build time so authors don't write fields the
    // runtime would silently drop. prompt, script, and branch all carry
    // both fields; the union narrowing below lets the compiler keep them
    // typed without a cast.
    if (s.kind === 'prompt' || s.kind === 'script' || s.kind === 'branch') {
      if (s.maxRetries !== undefined) {
        throw new FlowDefinitionError(
          `loop step body "${key}" sets maxRetries, but body steps run without per-step retry — the loop iteration is the recovery boundary. Remove maxRetries from this body step.`,
        );
      }
      if (s.timeoutMs !== undefined) {
        throw new FlowDefinitionError(
          `loop step body "${key}" sets timeoutMs, but body steps run without per-step timeout — the loop iteration is the recovery boundary. Remove timeoutMs from this body step.`,
        );
      }
    }
  }

  const handoffProducers = bodyKeys.filter((key) => {
    const s = spec.body[key];
    if (s === undefined || s.kind !== 'prompt') return false;
    const output = s.output;
    return 'handoff' in output && output.handoff === spec.until.from;
  });

  if (handoffProducers.length === 0) {
    throw new FlowDefinitionError(
      `loop step until.from "${spec.until.from}" does not match any body step's handoff output`,
    );
  }

  if (!Number.isInteger(spec.maxIterations) || spec.maxIterations <= 0) {
    throw new FlowDefinitionError('loop step maxIterations must be a positive integer');
  }

  const compiledBody = compileBodySteps(spec.body);

  const assembled: LoopStepBuilderOutput = {
    ...spec,
    kind: 'loop',
    body: compiledBody,
    bodyGraph: undefined,
  };

  const parseResult = loopStepSpecSchema.safeParse({ id: '_', ...assembled });
  if (!parseResult.success) throw toFlowDefError(parseResult.error, 'invalid loop step');

  return assembled;
}
