import type { StepBuilderOutput } from '../flow/define.js';
import type { Step, StepKind } from '../flow/types.js';
import type { StepDispatchContext } from './step-dispatch-context.js';
import type { StepResult } from './types.js';

/**
 * The builder output member that corresponds to a single step kind. Each
 * `*StepBuilderOutput` carries the literal `kind: K` discriminant so this
 * extract narrows the broad union down to one variant.
 */
export type StepBuilderOutputForKind<K extends StepKind> = Extract<StepBuilderOutput, { kind: K }>;

/**
 * The compiled `Step` member that corresponds to a single step kind. Used by
 * `StepKindEntry.execute` so the kind-specific executor receives a precisely
 * typed step rather than the broad `Step` union.
 */
export type StepForKind<K extends StepKind> = Extract<Step, { kind: K }>;

/**
 * One entry in the StepKindRegistry. Carries the two seams the orchestrator
 * relies on per kind:
 *
 * - `synthesize`: turns a builder output (without an id) into a fully formed
 *   `Step` by injecting the id supplied by the flow compiler. This replaces
 *   the previous `synthesizeStep` switch in `defineFlow`.
 * - `execute`: invokes the per-kind step executor against a unified
 *   dispatch context. The orchestrator builds one `StepDispatchContext` per
 *   step and lets the entry adapt it to the kind-specific executor signature.
 *
 * The `kind` discriminant ties the generic parameters together so the
 * compiler enforces that an entry registered for `'prompt'` cannot accept a
 * `BranchStep` at execute time, and vice versa.
 */
export interface StepKindEntry<K extends StepKind> {
  readonly kind: K;
  synthesize(raw: StepBuilderOutputForKind<K>, id: string): StepForKind<K>;
  execute(step: StepForKind<K>, ctx: StepDispatchContext): Promise<StepResult>;
}

/**
 * Module-scoped registry of per-step-kind seams. Adding a new step kind is one
 * `register()` call instead of editing a switch in `defineFlow`, an if/else
 * chain in the orchestrator's runExecutor, and the per-kind types in two
 * other files.
 *
 * The registry is mutable but only writes-once per kind: re-registering the
 * same kind throws so a second `step-registrations.ts` import (e.g. from a
 * test file that bypasses the orchestrator) cannot silently shadow a default
 * entry. Entries are looked up by string discriminant; the generic on `get`
 * narrows the return type to the correct kind variant.
 */
export class StepKindRegistry {
  // Stored as `StepKindEntry<StepKind>` so the map can hold heterogeneous
  // entries; `register` and `get` re-narrow per-kind via their generic
  // parameter so callers see the precise variant.
  readonly #entries = new Map<StepKind, StepKindEntry<StepKind>>();

  /**
   * Register an entry for a single step kind. Throws when the same kind is
   * registered twice — re-registration is treated as a programming error so
   * tests and library code can rely on `defaultStepRegistry` having stable
   * entries from module load through process exit.
   */
  register<K extends StepKind>(entry: StepKindEntry<K>): void {
    if (this.#entries.has(entry.kind)) {
      throw new Error(`step kind "${entry.kind}" is already registered`);
    }
    // The cast widens the per-kind generic to the map's storage type; `get`
    // re-narrows when the caller supplies a kind discriminant. The two-step
    // cast is required because TypeScript cannot prove that an arbitrary
    // `K extends StepKind` is structurally compatible with the wider union.
    this.#entries.set(entry.kind, entry as unknown as StepKindEntry<StepKind>);
  }

  /**
   * Look up the entry for a step kind. Returns undefined for kinds that have
   * not been registered — callers decide whether to fall back, throw, or
   * surface a typed error. The generic is keyed off the supplied kind so the
   * returned entry's `synthesize`/`execute` signatures stay precise.
   */
  get<K extends StepKind>(kind: K): StepKindEntry<K> | undefined {
    const entry = this.#entries.get(kind);
    if (entry === undefined) return undefined;
    // Two-step cast — see `register` for why TypeScript cannot follow the
    // discriminant through the heterogeneous map's storage type.
    return entry as unknown as StepKindEntry<K>;
  }

  /**
   * Whether any entry has been registered for `kind`. Used by
   * `step-registrations.ts` to make default registration idempotent across
   * repeated module imports — re-importing the registrations file must not
   * throw on the second pass.
   */
  has(kind: StepKind): boolean {
    return this.#entries.has(kind);
  }
}

/**
 * Process-global default registry. Populated by `step-registrations.ts` when
 * that module is imported (the orchestrator imports it for side effects). All
 * runtime code that resolves step kinds (the flow compiler, the orchestrator,
 * tests) shares this single instance.
 */
export const defaultStepRegistry = new StepKindRegistry();
