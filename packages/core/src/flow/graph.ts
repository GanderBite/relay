import { FlowDefinitionError } from '../errors.js';
import type { FlowGraph, Step } from './types.js';

export type { FlowGraph } from './types.js';

export function buildGraph(steps: Record<string, Step>, start?: string): FlowGraph {
  const keys = Object.keys(steps);

  if (keys.length === 0) {
    throw new FlowDefinitionError('flow has no steps — define at least one step');
  }

  const stepMap = new Map<string, Step>();
  for (const key of keys) {
    const step = steps[key];
    if (step === undefined) {
      throw new FlowDefinitionError(`step "${key}" is undefined`);
    }
    if (step.id !== key && step.id !== '') {
      throw new FlowDefinitionError(
        `step key "${key}" does not match injected id "${step.id}"`,
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
    successors.get(from)!.add(to);
    predecessors.get(to)!.add(from);
  };

  for (const key of keys) {
    const step = stepMap.get(key)!;

    if (step.dependsOn !== undefined) {
      for (const dep of step.dependsOn) {
        if (!stepMap.has(dep)) {
          throw new FlowDefinitionError(
            `step "${key}" depends on unknown step "${dep}"`,
          );
        }
        addEdge(dep, key);
      }
    }

    if (step.kind === 'parallel') {
      for (const branch of step.branches) {
        if (!stepMap.has(branch)) {
          throw new FlowDefinitionError(
            `parallel step "${key}" branches to unknown step "${branch}"`,
          );
        }
      }

      if (step.onAllComplete !== undefined && !stepMap.has(step.onAllComplete)) {
        throw new FlowDefinitionError(
          `parallel step "${key}" onAllComplete references unknown step "${step.onAllComplete}"`,
        );
      }
    }

    if (step.onFail !== undefined && step.onFail !== 'abort' && step.onFail !== 'continue') {
      if (!stepMap.has(step.onFail)) {
        throw new FlowDefinitionError(
          `step "${key}" onFail references unknown step "${step.onFail}"`,
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
            throw new FlowDefinitionError(
              `step "${key}" onExit["${exitKey}"] references unknown step "${value}"`,
            );
          }
        }
      }
    }
  }

  const topoOrder = kahnTopoSort(keys, predecessors, successors);

  const rootSteps = keys.filter(k => predecessors.get(k)!.size === 0).sort();

  const entry = resolveEntry(stepMap, rootSteps, start);

  validateContextFrom(keys, stepMap, predecessors);

  const frozenSuccessors = new Map<string, ReadonlySet<string>>();
  const frozenPredecessors = new Map<string, ReadonlySet<string>>();
  for (const key of keys) {
    frozenSuccessors.set(key, successors.get(key)!);
    frozenPredecessors.set(key, predecessors.get(key)!);
  }

  return {
    successors: frozenSuccessors,
    predecessors: frozenPredecessors,
    topoOrder,
    rootSteps,
    entry,
  };
}

function kahnTopoSort(
  keys: readonly string[],
  predecessors: Map<string, Set<string>>,
  successors: Map<string, Set<string>>,
): readonly string[] {
  const inDegree = new Map<string, number>();
  for (const key of keys) {
    inDegree.set(key, predecessors.get(key)!.size);
  }

  const ready = keys.filter(k => inDegree.get(k) === 0).sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift()!;
    order.push(next);

    const nextSuccessors = Array.from(successors.get(next)!).sort();
    for (const succ of nextSuccessors) {
      const deg = inDegree.get(succ)! - 1;
      inDegree.set(succ, deg);
      if (deg === 0) {
        insertSorted(ready, succ);
      }
    }
  }

  if (order.length === keys.length) {
    return order;
  }

  const remaining = new Set(keys.filter(k => (inDegree.get(k) ?? 0) > 0));
  const path = traceCycle(remaining, successors);
  throw new FlowDefinitionError(
    `cycle detected: ${path.join(' -> ')}`,
    { cycle: path },
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
    const succsInCycle = Array.from(succs).filter(s => remaining.has(s)).sort();
    current = succsInCycle[0];
  }

  return path;
}

function resolveEntry(
  stepMap: Map<string, Step>,
  rootSteps: readonly string[],
  start: string | undefined,
): string {
  if (start !== undefined) {
    if (!stepMap.has(start)) {
      throw new FlowDefinitionError(
        `start step "${start}" is not defined in this flow`,
      );
    }
    return start;
  }

  if (rootSteps.length === 1) {
    return rootSteps[0]!;
  }

  if (rootSteps.length === 0) {
    throw new FlowDefinitionError(
      'flow has no entry step — every step has a predecessor. Set `start:` to pick an entry.',
    );
  }

  throw new FlowDefinitionError(
    `flow has multiple root steps (${rootSteps.join(', ')}) — set \`start:\` to pick one`,
    { rootSteps: [...rootSteps] },
  );
}

function handoffNameOf(step: Step): string | undefined {
  if (step.kind === 'prompt') {
    return 'handoff' in step.output ? step.output.handoff : undefined;
  }
  return undefined;
}

function validateContextFrom(
  keys: readonly string[],
  stepMap: Map<string, Step>,
  predecessors: Map<string, Set<string>>,
): void {
  const producers = new Map<string, Set<string>>();
  for (const key of keys) {
    const step = stepMap.get(key)!;
    const name = handoffNameOf(step);
    if (name === undefined) continue;
    let set = producers.get(name);
    if (set === undefined) {
      set = new Set<string>();
      producers.set(name, set);
    }
    set.add(key);
  }

  for (const key of keys) {
    const step = stepMap.get(key)!;
    if (step.contextFrom === undefined || step.contextFrom.length === 0) continue;

    const ancestors = collectAncestors(key, predecessors);

    for (const required of step.contextFrom) {
      const writers = producers.get(required);
      if (writers === undefined) {
        throw new FlowDefinitionError(
          `step "${key}" contextFrom references unknown handoff "${required}"`,
        );
      }

      let hasAncestorWriter = false;
      for (const writer of writers) {
        if (ancestors.has(writer)) {
          hasAncestorWriter = true;
          break;
        }
      }

      if (!hasAncestorWriter) {
        throw new FlowDefinitionError(
          `step "${key}" contextFrom references handoff "${required}" that is not produced by any upstream step`,
        );
      }
    }
  }
}

function collectAncestors(
  stepId: string,
  predecessors: Map<string, Set<string>>,
): Set<string> {
  const ancestors = new Set<string>();
  const stack: string[] = [];
  const direct = predecessors.get(stepId);
  if (direct !== undefined) {
    for (const p of direct) stack.push(p);
  }

  while (stack.length > 0) {
    const next = stack.pop()!;
    if (ancestors.has(next)) continue;
    ancestors.add(next);
    const preds = predecessors.get(next);
    if (preds === undefined) continue;
    for (const p of preds) {
      if (!ancestors.has(p)) stack.push(p);
    }
  }

  return ancestors;
}
