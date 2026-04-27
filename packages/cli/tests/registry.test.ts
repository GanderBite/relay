import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateRegistryJson } from '../src/registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid relay metadata block for the registry generator.
 * All six fields checked by isRelayMeta are required: flowName, displayName,
 * tags, estimatedCostUsd, estimatedDurationMin, audience.
 */
function validRelayBlock(name: string): Record<string, unknown> {
  return {
    flowName: name,
    displayName: `${name} display`,
    tags: ['test'],
    estimatedCostUsd: { min: 0.01, max: 0.05 },
    estimatedDurationMin: { min: 1, max: 5 },
    audience: ['developer'],
  };
}

/**
 * Create a valid flow package directory in `parent/name`.
 *
 * The registry generator reads:
 *   - package.json (name, version, relay block — required)
 *   - README.md (optional; falls back to description when absent)
 *
 * Returns the absolute path to the created directory.
 */
async function createValidFlowDir(parent: string, name: string): Promise<string> {
  const dir = join(parent, name);
  await mkdir(dir, { recursive: true });

  const pkg = {
    name,
    version: '1.0.0',
    type: 'module',
    main: 'flow.js',
    description: `Description for ${name}`,
    relay: validRelayBlock(name),
  };
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg, null, 2), 'utf8');

  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateRegistryJson', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-reg-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('[TC-019] partial success — valid entries returned when one input path does not exist', async () => {
    const dirA = await createValidFlowDir(tmp, 'flow-a');
    const dirB = await createValidFlowDir(tmp, 'flow-b');
    // This path is guaranteed not to exist inside the temp dir
    const missing = join(tmp, 'does-not-exist');

    const r = await generateRegistryJson([dirA, missing, dirB]);

    // The function returns ok() when at least one input succeeds
    expect(r.isOk()).toBe(true);

    const doc = r._unsafeUnwrap();

    // Exactly two valid flow entries
    expect(doc.flows).toHaveLength(2);

    // Document version must be the literal 1
    expect(doc.version).toBe(1);

    // generatedAt must be a valid ISO-8601 timestamp
    expect(typeof doc.generatedAt).toBe('string');
    expect(Number.isNaN(new Date(doc.generatedAt).getTime())).toBe(false);
  });

  it('[TC-019] all-fail — returns err when every input path is missing', async () => {
    const missingA = join(tmp, 'no-such-dir-a');
    const missingB = join(tmp, 'no-such-dir-b');

    const r = await generateRegistryJson([missingA, missingB]);

    expect(r.isOk()).toBe(false);
  });

  it('[TC-019] single valid input — returns ok with one flow entry', async () => {
    const dirA = await createValidFlowDir(tmp, 'flow-only');

    const r = await generateRegistryJson([dirA]);

    expect(r.isOk()).toBe(true);
    const doc = r._unsafeUnwrap();
    expect(doc.flows).toHaveLength(1);
    expect(doc.flows[0]?.name).toBe('flow-only');
    expect(doc.version).toBe(1);
  });

  it('[TC-019] entry fields populated from package.json relay block', async () => {
    const dir = await createValidFlowDir(tmp, 'flow-fields');

    const r = await generateRegistryJson([dir]);

    expect(r.isOk()).toBe(true);
    const doc = r._unsafeUnwrap();
    const entry = doc.flows[0]!;

    expect(entry.name).toBe('flow-fields');
    expect(entry.version).toBe('1.0.0');
    expect(entry.displayName).toBe('flow-fields display');
    expect(entry.tags).toEqual(['test']);
    expect(entry.audience).toEqual(['developer']);
    expect(entry.estimatedCostUsd).toEqual({ min: 0.01, max: 0.05 });
    expect(entry.estimatedDurationMin).toEqual({ min: 1, max: 5 });
    // dist is populated by the GHA release workflow, not by local dir processing
    expect(entry.dist).toBeUndefined();
  });

  it('[TC-019] missing relay block causes that entry to be skipped while others succeed', async () => {
    const dirGood = await createValidFlowDir(tmp, 'flow-good');

    // Create a directory with an invalid relay block (missing flowName)
    const dirBad = join(tmp, 'flow-bad');
    await mkdir(dirBad, { recursive: true });
    const badPkg = {
      name: 'flow-bad',
      version: '1.0.0',
      relay: {
        // flowName is missing — isRelayMeta returns false
        displayName: 'Bad Flow',
        tags: ['test'],
        estimatedCostUsd: { min: 0.01, max: 0.05 },
        estimatedDurationMin: { min: 1, max: 5 },
        audience: ['developer'],
      },
    };
    await writeFile(join(dirBad, 'package.json'), JSON.stringify(badPkg, null, 2), 'utf8');

    const r = await generateRegistryJson([dirGood, dirBad]);

    expect(r.isOk()).toBe(true);
    const doc = r._unsafeUnwrap();
    // Only the good entry passes
    expect(doc.flows).toHaveLength(1);
    expect(doc.flows[0]?.name).toBe('flow-good');
  });
});
