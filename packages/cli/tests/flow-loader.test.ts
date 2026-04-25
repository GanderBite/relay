/**
 * Tests for flow-loader.ts — resolution order (TC-015) and duck-type guard
 * (TC-016).
 *
 * The loader calls `import(<abs-path>)` internally. In the Vitest/Node ESM
 * environment, dynamic import of a plain .js file at an absolute path works
 * without compilation. We therefore create real temp directories with real
 * flow.js files rather than mocking the import machinery — this gives us
 * coverage of the full resolution and validation path.
 *
 * All flow entries live at <dir>/dist/flow.js to match what the loader
 * actually imports (join(dir, 'dist', 'flow.js')).
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowLoadError, loadFlow } from '../src/flow-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Writes a minimal valid compiled flow package at `dir`.
 * The loader imports `<dir>/dist/flow.js` and validates the default export
 * against the duck-type guard: name (string), steps (object), graph (object
 * with successors/predecessors map-likes and topoOrder array).
 */
async function writeValidFlowPackage(dir: string, flowName: string): Promise<void> {
  await mkdir(join(dir, 'dist'), { recursive: true });

  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({ name: flowName, version: '1.0.0', type: 'module', main: 'dist/flow.js' }),
    'utf8',
  );

  // Plain ESM — no TypeScript needed. The duck-type check requires:
  //   name       : string
  //   steps      : non-null object
  //   graph      : object with
  //     successors   : map-like ({ get, has })
  //     predecessors : map-like ({ get, has })
  //     topoOrder    : array
  const content = `
const flow = {
  name: '${flowName}',
  version: '1.0.0',
  steps: {},
  graph: {
    successors: new Map(),
    predecessors: new Map(),
    topoOrder: [],
    rootSteps: [],
    get: (id) => undefined,
    has: (id) => false,
  },
  stepOrder: [],
  rootSteps: [],
  input: undefined,
};
export default flow;
`;
  await writeFile(join(dir, 'dist', 'flow.js'), content, 'utf8');
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'relay-fl-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// TC-015: Resolution order
// ---------------------------------------------------------------------------

describe('TC-015: loadFlow resolution order', () => {
  it('[TC-015a] explicit path (./my-flow) is loaded from that exact location', async () => {
    const flowDir = join(tmp, 'my-flow');
    await writeValidFlowPackage(flowDir, 'my-flow');

    const result = await loadFlow('./my-flow', tmp);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.flow.name).toBe('my-flow');
    expect(loaded.source).toBe('path');
    expect(loaded.dir).toBe(flowDir);
  });

  it('[TC-015b] named flow found in .relay/flows/<name>/ is loaded from there', async () => {
    const localDir = join(tmp, '.relay', 'flows', 'my-flow');
    await writeValidFlowPackage(localDir, 'my-flow');

    // node_modules counterpart does NOT exist — but even if it did, .relay/flows
    // wins because of resolution order.
    const result = await loadFlow('my-flow', tmp);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.flow.name).toBe('my-flow');
    expect(loaded.source).toBe('local');
    expect(loaded.dir).toBe(localDir);
  });

  it('[TC-015c] named flow with no .relay/flows entry falls through to node_modules', async () => {
    // No .relay/flows/my-flow — only node_modules/@ganderbite/flow-my-flow
    const nmDir = join(tmp, 'node_modules', '@ganderbite', 'flow-my-flow');
    await writeValidFlowPackage(nmDir, '@ganderbite/flow-my-flow');

    const result = await loadFlow('my-flow', tmp);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.flow.name).toBe('@ganderbite/flow-my-flow');
    expect(loaded.source).toBe('node_modules');
    expect(loaded.dir).toBe(nmDir);
  });

  it('[TC-015d] unknown flow name returns err(FlowLoadError) with remediation hint', async () => {
    // Neither .relay/flows nor node_modules has this flow.
    const result = await loadFlow('no-such-flow', tmp);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(FlowLoadError);
    expect(error.code).toBe('relay_FLOW_NOT_FOUND');
    // The message must name the flow and instruct the user to run `relay install`.
    expect(error.message).toContain('no-such-flow');
    expect(error.message).toMatch(/relay install/i);
  });

  it('[TC-015e] explicit path that does not exist returns err with code relay_FLOW_INVALID', async () => {
    // Path-like argument → loader goes to importFlow directly (no fallthrough).
    // The dir does not exist, so the dynamic import fails → FLOW_INVALID.
    const result = await loadFlow('./does-not-exist', tmp);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(FlowLoadError);
    // A missing path-like target is an import failure, not a "not found in
    // the known resolution locations" case — the loader returns FLOW_INVALID.
    expect(error.code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-015f] .relay/flows entry with invalid flow does NOT fall through to node_modules', async () => {
    // A flow module exists in .relay/flows but fails the duck-type check.
    // The loader must surface the FLOW_INVALID error, NOT silently check node_modules.
    const localDir = join(tmp, '.relay', 'flows', 'my-flow');
    await mkdir(join(localDir, 'dist'), { recursive: true });
    // Module exists and loads successfully, but has no graph — duck-type will reject it.
    await writeFile(
      join(localDir, 'dist', 'flow.js'),
      `export default { name: 'my-flow', steps: {} };`,
      'utf8',
    );

    // Put a valid flow in node_modules too — loader must NOT reach it.
    const nmDir = join(tmp, 'node_modules', '@ganderbite', 'flow-my-flow');
    await writeValidFlowPackage(nmDir, '@ganderbite/flow-my-flow');

    const result = await loadFlow('my-flow', tmp);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(FlowLoadError);
    expect(error.code).toBe('relay_FLOW_INVALID');
  });
});

// ---------------------------------------------------------------------------
// TC-016: Duck-type guard
// ---------------------------------------------------------------------------

describe('TC-016: duck-type guard rejects invalid flow shapes', () => {
  it('[TC-016a] graph present but missing topoOrder → err with code relay_FLOW_INVALID', async () => {
    const flowDir = join(tmp, 'bad-flow');
    await mkdir(join(flowDir, 'dist'), { recursive: true });
    // graph exists but lacks topoOrder — isFlow() must reject it.
    const badContent = `
export default {
  name: 'bad-flow',
  steps: {},
  graph: {
    successors: new Map(),
    predecessors: new Map(),
  },
};
`;
    await writeFile(join(flowDir, 'dist', 'flow.js'), badContent, 'utf8');

    const result = await loadFlow('./bad-flow', tmp);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(FlowLoadError);
    expect(error.code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-016b] graph.successors not map-like → err with code relay_FLOW_INVALID', async () => {
    const flowDir = join(tmp, 'bad-flow-2');
    await mkdir(join(flowDir, 'dist'), { recursive: true });
    const badContent = `
export default {
  name: 'bad-flow-2',
  steps: {},
  graph: {
    successors: {},
    predecessors: new Map(),
    topoOrder: [],
  },
};
`;
    await writeFile(join(flowDir, 'dist', 'flow.js'), badContent, 'utf8');

    const result = await loadFlow('./bad-flow-2', tmp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-016c] missing name field → err with code relay_FLOW_INVALID', async () => {
    const flowDir = join(tmp, 'bad-flow-3');
    await mkdir(join(flowDir, 'dist'), { recursive: true });
    const badContent = `
export default {
  steps: {},
  graph: {
    successors: new Map(),
    predecessors: new Map(),
    topoOrder: [],
  },
};
`;
    await writeFile(join(flowDir, 'dist', 'flow.js'), badContent, 'utf8');

    const result = await loadFlow('./bad-flow-3', tmp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-016d] default export is null → err with code relay_FLOW_INVALID', async () => {
    const flowDir = join(tmp, 'null-flow');
    await mkdir(join(flowDir, 'dist'), { recursive: true });
    await writeFile(join(flowDir, 'dist', 'flow.js'), `export default null;`, 'utf8');

    const result = await loadFlow('./null-flow', tmp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-016e] default export is missing (no default export) → err with code relay_FLOW_INVALID', async () => {
    const flowDir = join(tmp, 'no-default-flow');
    await mkdir(join(flowDir, 'dist'), { recursive: true });
    // Named export only — no default export → duck-type gets undefined.
    await writeFile(
      join(flowDir, 'dist', 'flow.js'),
      `export const name = 'no-default-flow';`,
      'utf8',
    );

    const result = await loadFlow('./no-default-flow', tmp);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('relay_FLOW_INVALID');
  });

  it('[TC-016f] FlowLoadError has name FlowLoadError (instanceof check on subclass)', async () => {
    const result = await loadFlow('definitely-not-installed', tmp);

    expect(result.isErr()).toBe(true);
    const error = result._unsafeUnwrapErr();
    expect(error).toBeInstanceOf(FlowLoadError);
    expect(error.name).toBe('FlowLoadError');
  });
});

// ---------------------------------------------------------------------------
// TC-017: Path resolution when a fully-qualified .js entry path is supplied
// ---------------------------------------------------------------------------

describe('TC-017: path-like with .js extension', () => {
  it('[TC-017a] passing the full compiled entry path resolves to the package root', async () => {
    const pkgDir = join(tmp, 'my-pkg');
    await writeValidFlowPackage(pkgDir, 'my-pkg');

    // Pass the full <pkgDir>/dist/flow.js path — this is what the double-path
    // fix in flow-loader.ts must handle without doubling the dist/flow.js suffix.
    const entryPath = join(pkgDir, 'dist', 'flow.js');
    const result = await loadFlow(entryPath, tmp);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.flow.name).toBe('my-pkg');
    expect(loaded.source).toBe('path');
    // dir must be the package root, not the .js file path or dist/
    expect(loaded.dir).toBe(pkgDir);
  });

  it('[TC-017b] passing a directory path (no .js extension) still resolves correctly', async () => {
    const pkgDir = join(tmp, 'my-pkg-dir');
    await writeValidFlowPackage(pkgDir, 'my-pkg-dir');

    // Pass the package root directory (absolute path, no .js suffix).
    const result = await loadFlow(pkgDir, tmp);

    expect(result.isOk()).toBe(true);
    const loaded = result._unsafeUnwrap();
    expect(loaded.flow.name).toBe('my-pkg-dir');
    expect(loaded.source).toBe('path');
    expect(loaded.dir).toBe(pkgDir);
  });
});
