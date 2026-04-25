import { describe, expect, it } from 'vitest';

// Path from packages/core/tests/integration/ -> packages/core/tests/ -> packages/core/ -> packages/ -> packages/flows/codebase-discovery/dist/
import cobaseDiscoveryFlow from '../../../flows/codebase-discovery/dist/flow.js';

describe('codebase-discovery flow regression guard', () => {
  it('[TC-026] flow compiles to a valid Flow object with correct structure', () => {
    const flow = cobaseDiscoveryFlow;

    expect(flow.name).toBe('codebase-discovery');
    expect(typeof flow.steps).toBe('object');
    expect(Object.keys(flow.steps)).toHaveLength(4);

    // Step names must match the four prompt files defined in the flow
    expect(Object.keys(flow.steps)).toContain('inventory');
    expect(Object.keys(flow.steps)).toContain('entities');
    expect(Object.keys(flow.steps)).toContain('services');
    expect(Object.keys(flow.steps)).toContain('report');

    // Kahn sort processes nodes with in-degree 0 first (sorted alphabetically).
    // Only 'inventory' has no dependsOn, so it is the sole root and must appear
    // first. 'entities' and 'services' both unblock when 'inventory' completes
    // (sorted alphabetically: entities < services). 'report' is last.
    expect(Array.isArray(flow.graph.topoOrder)).toBe(true);
    expect(flow.graph.topoOrder).toHaveLength(4);
    expect(flow.graph.topoOrder[0]).toBe('inventory');

    // Only 'inventory' has no predecessors — it must be the only root step.
    expect(flow.graph.rootSteps).toHaveLength(1);
    expect(flow.graph.rootSteps[0]).toBe('inventory');

    // Version must match the package
    expect(flow.version).toBe('0.1.0');
  });
});
