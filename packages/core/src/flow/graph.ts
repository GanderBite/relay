import { err, ok, type Result } from 'neverthrow';
import { GITHUB_ISSUES_URL } from '../constants.js';
import { FlowDefinitionError } from '../errors.js';
import { lookup } from '../util/map-utils.js';
import type { FlowGraph, LoopStep, Step } from './types.js';

export type { FlowGraph } from './types.js';

export function buildGraph(
  steps: Record<string, Step>,
  start?: string,
): Result<FlowGraph, FlowDefinitionError> {
  return buildGraphInternal(steps, start, false);
}

function buildGraphInternal(
  steps: Record<string, Step>,
  start: string | undefined,
  isBody: boolean,
): Result<FlowGraph, FlowDefinitionError> {
  const keys = Object.keys(steps);

  if (keys.length === 0) {
    return err(
      new FlowDefinitionError(
        'flow has no steps. Add at least one step via `steps: { ... }` in defineFlow(...).',
      ),
    );
  }

  const stepMap = new Map<string, Step>();
  for (const key of keys) {
    const step = steps[key];
    if (step === undefined) {
      return err(
        new FlowDefinitionError(
          `step "${key}" is undefined. Assign a value via step.prompt(...), step.script(...), step.branch(...), step.parallel(...), or step.terminal(...) in defineFlow(...).`,
        ),
      );
    }
    if (step.id !== key && step.id !== '') {
      return err(
        new FlowDefinitionError(
          `step key "${key}" does not match injected id "${step.id}". Use the same id for both the "steps" map key and any explicit step.id — remove the conflicting value from the step builder arguments.`,
        ),
      );
    }
    stepMap.set(key, step);
  }

  const successors = new Map<string, Set<string>>();
  const predecessors = new Map<string, Set<string>>();
  for (const key of keys) {
    successors.set(key, new Set<string>());
    predecessors.set(key, new Set<string>());
  }

  const addEdge = (from: string, to: string): void => {
    // Invariant: `from` and `to` are both keys in stepMap, so both maps
    // have an entry initialised to an empty Set above.
    successors.get(from)?.add(to);
    predecessors.get(to)?.add(from);
  };

  for (const key of keys) {
    // Invariant: `key` was just inserted into stepMap above.
    const step = lookup(stepMap, key)._unsafeUnwrap();

    if (step.dependsOn !== undefined) {
      for (const dep of step.dependsOn) {
        if (!stepMap.has(dep)) {
          return err(
            new FlowDefinitionError(
              `step "${key}" depends on unknown step "${dep}". Remove "${dep}" from step "${key}"'s dependsOn array or define a step with id "${dep}" in defineFlow(...).`,
            ),
          );
        }
        addEdge(dep, key);
      }
    }

    if (step.kind === 'parallel') {
      // Build a set of declared predecessors for O(1) lookup below.
      const depSet = new Set(step.dependsOn ?? []);

      for (const branch of step.branches) {
        if (branch === key) {
          return err(
            new FlowDefinitionError(
              `parallel step "${key}" lists itself in "branches". Remove "${key}" from the branches array in defineFlow(...) — a parallel step cannot fan out to itself.`,
            ),
          );
        }
        if (!stepMap.has(branch)) {
          return err(
            new FlowDefinitionError(
              `parallel step "${key}" branches to unknown step "${branch}". Remove "${branch}" from step "${key}"'s branches array or define a step with id "${branch}" in defineFlow(...).`,
            ),
          );
        }
        // Synthetic predecessor edge: branches must wait for the parallel step
        // before the DAG walker schedules them. Without this, a branch with no
        // explicit dependsOn becomes a root step and the walker would dispatch
        // it before the parallel step runs.
        //
        // Skip when the branch is already a declared predecessor (via
        // dependsOn). In the fan-in barrier pattern both lists name the same
        // steps; dependsOn already adds branch→parallel edges, so adding the
        // reverse would form a cycle.
        if (!depSet.has(branch)) {
          addEdge(key, branch);
        }
      }

      if (step.onAllComplete !== undefined && !stepMap.has(step.onAllComplete)) {
        return err(
          new FlowDefinitionError(
            `parallel step "${key}" onAllComplete references unknown step "${step.onAllComplete}". Set onAllComplete to an existing step id or define a step with id "${step.onAllComplete}" in defineFlow(...).`,
          ),
        );
      }
    }

    // `onFail` exists on every step kind except 'terminal' and 'ask'. Narrow
    // by kind before reading. Parallel's onFail is limited to 'abort' |
    // <stepId>, so only 'abort' is an early-return here; 'continue' is not
    // valid for parallel at the type level.
    if (step.kind !== 'terminal' && step.kind !== 'ask' && step.onFail !== undefined) {
      const onFail = step.onFail;
      const isLiteral = onFail === 'abort' || (step.kind !== 'parallel' && onFail === 'continue');
      if (!isLiteral && !stepMap.has(onFail)) {
        return err(
          new FlowDefinitionError(
            `step "${key}" onFail references unknown step "${onFail}". Set onFail to "abort", "continue", or an existing step id in defineFlow(...).`,
          ),
        );
      }
    }

    if (step.kind === 'script' || step.kind === 'branch') {
      const onExit = step.onExit;
      if (onExit !== undefined) {
        for (const exitKey of Object.keys(onExit)) {
          const value = onExit[exitKey];
          if (value === undefined) continue;
          if (value === 'abort' || value === 'continue') continue;
          if (!stepMap.has(value)) {
            return err(
              new FlowDefinitionError(
                `step "${key}" onExit["${exitKey}"] references unknown step "${value}". Set onExit["${exitKey}"] to "abort", "continue", or an existing step id in defineFlow(...).`,
              ),
            );
          }
          addEdge(key, value);
        }
      }
    }
  }

  const topoResult = kahnTopoSort(keys, predecessors, successors);
  if (topoResult.isErr()) return err(topoResult.error);
  const topoOrder = topoResult.value;

  const rootSteps = keys
    // Invariant: every key in `keys` was initialised in `predecessors`.
    .filter((k) => lookup(predecessors, k)._unsafeUnwrap().size === 0)
    .sort();

  const entryResult = resolveEntry(stepMap, rootSteps, start);
  if (entryResult.isErr()) return err(entryResult.error);
  const entry = entryResult.value;

  const ancestorSets = computeAncestorSets(topoOrder, predecessors);

  const ctxResult = validateContextFrom(keys, stepMap, ancestorSets, isBody);
  if (ctxResult.isErr()) return err(ctxResult.error);

  const askResult = validateAskQuestionSources(keys, stepMap, ancestorSets);
  if (askResult.isErr()) return err(askResult.error);

  const parallelAskResult = validateParallelAskQuota(topoOrder, stepMap, successors);
  if (parallelAskResult.isErr()) return err(parallelAskResult.error);

  const frozenSuccessors = new Map<string, ReadonlySet<string>>();
  const frozenPredecessors = new Map<string, ReadonlySet<string>>();
  for (const key of keys) {
    // Invariant: every key in `keys` was initialised in both maps.
    frozenSuccessors.set(key, lookup(successors, key)._unsafeUnwrap());
    frozenPredecessors.set(key, lookup(predecessors, key)._unsafeUnwrap());
  }

  // Compile a nested mini-graph for each loop step's body. Body steps live
  // in the loop step's `body` record and never appear in this outer graph's
  // step map, edges, or topo order — they are validated as their own DAG
  // and the resulting graph is attached to the loop step in place.
  if (!isBody) {
    for (const key of topoOrder) {
      // Invariant: every key in topoOrder was inserted into stepMap above.
      const step = lookup(stepMap, key)._unsafeUnwrap();
      if (step.kind !== 'loop') continue;
      const bodyResult = buildBodyGraph(step);
      if (bodyResult.isErr()) return err(bodyResult.error);
      // Attach the compiled body graph to the loop step. The bodyGraph
      // field is declared optional on the spec and populated here once
      // the outer graph has accepted the step.
      step.bodyGraph = bodyResult.value;
    }
  }

  return ok({
    successors: frozenSuccessors,
    predecessors: frozenPredecessors,
    topoOrder,
    rootSteps,
    entry,
  });
}

function buildBodyGraph(loopStep: LoopStep): Result<FlowGraph, FlowDefinitionError> {
  const body = loopStep.body;
  for (const [bodyKey, bodyStep] of Object.entries(body)) {
    if (bodyStep === undefined) continue;
    if (bodyStep.kind === 'loop') {
      return err(
        new FlowDefinitionError(
          `loop step "${loopStep.id}" body contains nested loop step "${bodyKey}". Nested loops are not supported — flatten the body or move the inner loop into a separate flow.`,
        ),
      );
    }
  }
  return buildGraphInternal(body, loopStep.start, true);
}

function kahnTopoSort(
  keys: readonly string[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): Result<readonly string[], FlowDefinitionError> {
  const inDegree = new Map<string, number>();
  for (const key of keys) {
    // Invariant: `key` was initialised in `predecessors` by the caller.
    inDegree.set(key, lookup(predecessors, key)._unsafeUnwrap().size);
  }

  const ready = keys.filter((k) => inDegree.get(k) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) break;
    order.push(next);

    // Invariant: `next` originated from `ready`, which is seeded from `keys`.
    const nextSuccessors = Array.from(lookup(successors, next)._unsafeUnwrap()).sort();
    for (const succ of nextSuccessors) {
      // Invariant: `succ` is a key from `successors`, so it has an inDegree entry.
      const deg = lookup(inDegree, succ)._unsafeUnwrap() - 1;
      inDegree.set(succ, deg);
      if (deg === 0) {
        insertSorted(ready, succ);
      }
    }
  }

  if (order.length === keys.length) {
    return ok(order);
  }

  const remaining = new Set(keys.filter((k) => (inDegree.get(k) ?? 0) > 0));
  const path = traceCycle(remaining, successors);
  return err(
    new FlowDefinitionError(
      `cycle detected in step dependencies: ${path.join(' -> ')}. Remove one of the dependsOn references in this cycle so the flow has a valid topological order.`,
      { cyclePath: [...path] },
    ),
  );
}

function insertSorted(arr: string[], value: string): void {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const midValue = arr[mid];
    if (midValue !== undefined && midValue < value) lo = mid + 1;
    else hi = mid;
  }
  arr.splice(lo, 0, value);
}

function traceCycle(
  remaining: ReadonlySet<string>,
  successors: Map<string, Set<string>>,
): readonly string[] {
  const sorted = Array.from(remaining).sort();
  const start = sorted[0];
  if (start === undefined) {
    return ['<unknown>'];
  }

  const seenIndex = new Map<string, number>();
  const path: string[] = [];
  let current: string | undefined = start;

  while (current !== undefined) {
    const existing = seenIndex.get(current);
    if (existing !== undefined) {
      const cycle = path.slice(existing);
      cycle.push(current);
      return cycle;
    }
    seenIndex.set(current, path.length);
    path.push(current);

    const succs = successors.get(current);
    if (succs === undefined || succs.size === 0) {
      return path;
    }
    const succsInCycle = Array.from(succs)
      .filter((s) => remaining.has(s))
      .sort();
    current = succsInCycle[0];
  }

  return path;
}

function resolveEntry(
  stepMap: Map<string, Step>,
  rootSteps: readonly string[],
  start: string | undefined,
): Result<string, FlowDefinitionError> {
  if (start !== undefined) {
    if (!stepMap.has(start)) {
      return err(
        new FlowDefinitionError(
          `start step "${start}" is not defined in this flow. Set start to an existing step id or add a step with id "${start}" in defineFlow(...).`,
        ),
      );
    }
    return ok(start);
  }

  if (rootSteps.length === 1) {
    const entry = rootSteps[0];
    if (entry === undefined) {
      // Defensive fallback when an invariant violation leaks through the guard.
      return err(
        new FlowDefinitionError(
          `unexpected graph state: rootSteps[0] is undefined despite length === 1. This is likely a bug in Relay — please report it at ${GITHUB_ISSUES_URL}.`,
        ),
      );
    }
    return ok(entry);
  }

  if (rootSteps.length === 0) {
    return err(
      new FlowDefinitionError(
        'flow has no entry step — every step has a predecessor. Remove a dependsOn reference on one step so it becomes a root, or set start: "<stepId>" in defineFlow(...) to pick an entry.',
      ),
    );
  }

  return err(
    new FlowDefinitionError(
      `flow has multiple root steps (${rootSteps.join(', ')}). Set start: "${rootSteps[0] ?? '<stepId>'}" (or another valid step id) in defineFlow(...) to pick an entry point.`,
      { rootSteps: [...rootSteps] },
    ),
  );
}

function handoffNameOf(step: Step): string | undefined {
  if (step.kind === 'prompt') {
    return 'handoff' in step.output ? step.output.handoff : undefined;
  }
  // Ask steps publish the collected answer map as a handoff named after the
  // step id. The on-disk __ask_<stepId>__ file is the input written by the
  // CLI; the orchestrator reads it then writes the answer map under the
  // step id so downstream `contextFrom: ['<askStepId>']` resolves through
  // the standard handoff path.
  if (step.kind === 'ask') {
    return step.id;
  }
  return undefined;
}

/**
 * Shared producer maps used by every cross-step handoff validator.
 *
 * `producers` maps a handoff name to the set of step ids in this scope that
 * publish it (prompt steps via `output.handoff`, ask steps via their step id).
 *
 * `loopBodyHandoffs` maps a handoff name to the enclosing loop step id when
 * the handoff is produced exclusively inside a loop body. Outer-scope steps
 * cannot read those handoffs by their bare name and must use the dotted
 * `<loopStepId>.<handoff>` address; the reverse-lookup lets validators emit
 * a targeted error explaining the required form.
 */
function buildProducerMaps(
  keys: readonly string[],
  stepMap: Map<string, Step>,
): { producers: Map<string, Set<string>>; loopBodyHandoffs: Map<string, string> } {
  const producers = new Map<string, Set<string>>();
  const loopBodyHandoffs = new Map<string, string>();

  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookup(stepMap, key)._unsafeUnwrap();

    const name = handoffNameOf(step);
    if (name !== undefined) {
      let set = producers.get(name);
      if (set === undefined) {
        set = new Set<string>();
        producers.set(name, set);
      }
      set.add(key);
    }

    if (step.kind === 'loop') {
      for (const bodyStep of Object.values(step.body)) {
        if (bodyStep === undefined) continue;
        const bodyHandoff = handoffNameOf(bodyStep);
        if (bodyHandoff !== undefined && !loopBodyHandoffs.has(bodyHandoff)) {
          loopBodyHandoffs.set(bodyHandoff, key);
        }
      }
    }
  }

  return { producers, loopBodyHandoffs };
}

function validateContextFrom(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
  isBody: boolean,
): Result<void, FlowDefinitionError> {
  const { producers, loopBodyHandoffs } = buildProducerMaps(keys, stepMap);

  for (const key of keys) {
    // Invariant: every `key` was inserted into `stepMap` by the caller.
    const step = lookup(stepMap, key)._unsafeUnwrap();

    // Only prompt steps declare `contextFrom`. Narrow before reading.
    if (step.kind !== 'prompt') continue;
    if (step.contextFrom === undefined || step.contextFrom.length === 0) continue;

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookup(ancestorSets, key)._unsafeUnwrap();

    for (const raw of step.contextFrom) {
      // Dotted ids name a handoff in a different scope (e.g. parent flow or
      // a sibling loop iteration). The compiler cannot resolve them — they
      // are validated when the runtime materialises the context.
      if (raw.includes('.')) continue;

      // A trailing '?' marks the contextFrom entry as optional. Strip it
      // before lookup; the optional marker tells the runtime to tolerate a
      // missing handoff at injection time, not the compiler.
      const isOptional = raw.endsWith('?');
      const required = isOptional ? raw.slice(0, -1) : raw;

      const writers = producers.get(required);
      if (writers === undefined) {
        // Inside a loop body, an optional ref may resolve against an outer
        // scope handoff that this body cannot see. Skip the producer check
        // in that case; the runtime will handle resolution and absence.
        if (isBody && isOptional) continue;

        // Check whether the handoff is produced inside a loop body. If so,
        // emit a targeted message explaining the dotted-notation address.
        const loopStepId = loopBodyHandoffs.get(required);
        if (loopStepId !== undefined) {
          return err(
            new FlowDefinitionError(
              `step "${key}" contextFrom references handoff "${required}" which is produced inside loop step "${loopStepId}". Address it as "${loopStepId}.${required}" to read the loop's latest output.`,
            ),
          );
        }

        return err(
          new FlowDefinitionError(
            `step "${key}" contextFrom references unknown handoff "${required}". Remove "${required}" from step "${key}"'s contextFrom array or add an upstream prompt step whose output declares handoff: "${required}" in defineFlow(...).`,
          ),
        );
      }

      // Optional refs inside a loop body do not require an ancestor writer:
      // a sibling body step (or an outer-scope step) may produce the value
      // depending on which iteration path runs.
      if (isBody && isOptional) continue;

      let hasAncestorWriter = false;
      for (const writer of writers) {
        if (ancestors.has(writer)) {
          hasAncestorWriter = true;
          break;
        }
      }

      if (!hasAncestorWriter) {
        return err(
          new FlowDefinitionError(
            `step "${key}" contextFrom references handoff "${required}" that is not produced by any upstream step. Add a dependsOn link from step "${key}" to the step that writes handoff "${required}" in defineFlow(...).`,
          ),
        );
      }
    }
  }

  return ok(undefined);
}

/**
 * Validate ask steps that source their questions dynamically from a prior
 * step's handoff (`questions: { from: 'handoffName' }`). The referenced
 * handoff must be produced by an upstream prompt step in the same scope —
 * a handoff written exclusively inside a loop body cannot be read by an ask
 * step that lives outside the loop, because the loop body's handoffs only
 * resolve to the dotted address `<loopStepId>.<handoff>` from outside.
 *
 * Static question arrays need no graph-level check; their schema validation
 * happens elsewhere and they carry no cross-step references.
 */
function validateAskQuestionSources(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  ancestorSets: ReadonlyMap<string, ReadonlySet<string>>,
): Result<void, FlowDefinitionError> {
  const { producers, loopBodyHandoffs } = buildProducerMaps(keys, stepMap);

  for (const key of keys) {
    const step = lookup(stepMap, key)._unsafeUnwrap();
    if (step.kind !== 'ask') continue;
    if (Array.isArray(step.questions)) continue;

    const from = step.questions.from;
    const writers = producers.get(from);

    if (writers === undefined) {
      const loopStepId = loopBodyHandoffs.get(from);
      if (loopStepId !== undefined) {
        return err(
          new FlowDefinitionError(
            `ask step "${key}" sources questions from handoff "${from}" which is produced inside loop step "${loopStepId}". A loop-scoped handoff cannot be read by an ask step outside the loop — move the ask step into the loop body, or have a step outside the loop produce handoff "${from}".`,
          ),
        );
      }

      return err(
        new FlowDefinitionError(
          `ask step "${key}" sources questions from unknown handoff "${from}". Add an upstream prompt step whose output declares handoff: "${from}", or replace the dynamic source with a static questions array in defineFlow(...).`,
        ),
      );
    }

    // Invariant: every `key` has an entry in `ancestorSets` (computed in topo order).
    const ancestors = lookup(ancestorSets, key)._unsafeUnwrap();
    let hasAncestorWriter = false;
    for (const writer of writers) {
      if (ancestors.has(writer)) {
        hasAncestorWriter = true;
        break;
      }
    }

    if (!hasAncestorWriter) {
      return err(
        new FlowDefinitionError(
          `ask step "${key}" sources questions from handoff "${from}" that is not produced by any upstream step. Add a dependsOn link from step "${key}" to the step that writes handoff "${from}" in defineFlow(...).`,
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Reject parallel barriers whose reachable subgraph contains more than one
 * ask step. Concurrent ask steps cannot share the CLI's interactive prompt,
 * so the runtime forbids fanning out to multiple ask steps from a single
 * parallel step. Loop bodies reachable from a branch are walked recursively
 * so an ask buried inside a loop body still counts toward the quota.
 */
function validateParallelAskQuota(
  topoOrder: readonly string[],
  stepMap: Map<string, Step>,
  successors: Map<string, Set<string>>,
): Result<void, FlowDefinitionError> {
  for (const parallelId of topoOrder) {
    const parallel = lookup(stepMap, parallelId)._unsafeUnwrap();
    if (parallel.kind !== 'parallel') continue;

    const reachable = new Set<string>();
    const queue: string[] = [];
    for (const branch of parallel.branches) {
      if (!reachable.has(branch) && stepMap.has(branch)) {
        reachable.add(branch);
        queue.push(branch);
      }
    }

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const succs = successors.get(current);
      if (succs === undefined) continue;
      for (const succ of succs) {
        if (reachable.has(succ)) continue;
        if (!stepMap.has(succ)) continue;
        reachable.add(succ);
        queue.push(succ);
      }
    }

    const askIds: string[] = [];
    for (const id of reachable) {
      const step = lookup(stepMap, id)._unsafeUnwrap();
      if (step.kind === 'ask') {
        askIds.push(id);
        continue;
      }
      if (step.kind === 'loop') {
        collectLoopBodyAsks(step, askIds);
      }
    }

    if (askIds.length > 1) {
      askIds.sort();
      return err(
        new FlowDefinitionError(
          `parallel step "${parallelId}" has ${askIds.length} concurrent ask steps in its branches (${askIds.join(', ')}): concurrent asks are not supported — sequence them before or after the barrier.`,
        ),
      );
    }
  }

  return ok(undefined);
}

/**
 * Recursively collect ask step ids inside a loop body, descending through any
 * nested loop bodies. Body steps are addressed by their bare id; the caller is
 * responsible for deduping across the outer reachable set if needed.
 */
function collectLoopBodyAsks(loopStep: LoopStep, into: string[]): void {
  for (const bodyStep of Object.values(loopStep.body)) {
    if (bodyStep === undefined) continue;
    if (bodyStep.kind === 'ask') {
      into.push(bodyStep.id);
      continue;
    }
    if (bodyStep.kind === 'loop') {
      collectLoopBodyAsks(bodyStep, into);
    }
  }
}

/**
 * Compute each step's ancestor set in a single linear pass over the topological
 * order. Ancestors(step) = union over each predecessor p of (Ancestors(p) ∪ {p}).
 * Because topoOrder guarantees predecessors are visited before their successors,
 * every predecessor's ancestor set is already memoized when we reach the step.
 * This replaces the previous per-step DFS, which was O(V * (V+E)) in aggregate.
 */
function computeAncestorSets(
  topoOrder: readonly string[],
  predecessors: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const ancestorSets = new Map<string, ReadonlySet<string>>();

  for (const key of topoOrder) {
    const preds = predecessors.get(key);
    const merged = new Set<string>();
    if (preds !== undefined) {
      for (const pred of preds) {
        merged.add(pred);
        const predAncestors = ancestorSets.get(pred);
        if (predAncestors !== undefined) {
          for (const a of predAncestors) merged.add(a);
        }
      }
    }
    ancestorSets.set(key, merged);
  }

  return ancestorSets;
}
