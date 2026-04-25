import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lintFlowPackage } from '../src/lint.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid relay metadata block. flowName is required by the linter. */
function validRelayBlock(): Record<string, unknown> {
  return {
    flowName: 'test-flow',
    displayName: 'Test Flow',
    description: 'A test flow',
    estimatedCostUsd: { min: 0.01, max: 0.05 },
    estimatedDurationMin: { min: 1, max: 5 },
    tags: ['test'],
    audience: ['developer'],
  };
}

/** Build a minimal valid package.json string, optionally overriding relay block fields. */
function validPackageJson(relayOverrides?: Record<string, unknown>): string {
  return JSON.stringify(
    {
      name: 'test-flow',
      version: '1.0.0',
      type: 'module',
      main: 'flow.js',
      relay: { ...validRelayBlock(), ...relayOverrides },
    },
    null,
    2,
  );
}

/** A flow.ts stub with a default export — satisfies the entry-point check. */
const FLOW_TS_STUB = `import { defineFlow } from '@relay/core';
export default defineFlow({ id: 'test-flow', steps: [] });
`;

/**
 * A flow.ts stub that references promptFile — triggers the prompts/ directory
 * check inside checkPromptsDirectory.
 */
const FLOW_TS_PROMPT_FILE_STUB = `import { defineFlow } from '@relay/core';
export default defineFlow({
  id: 'test-flow',
  steps: [{ id: 'step-1', promptFile: 'prompts/01_step.md' }],
});
`;

/** README with all 5 required sections present. */
const FULL_README = `# Test Flow

## What it does

Does something useful.

## Sample output

\`\`\`
some output
\`\`\`

## Estimated cost and duration

Cheap and fast.

## Install

\`\`\`
npm install
\`\`\`

## Run

\`\`\`
relay run test-flow
\`\`\`
`;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

describe('lintFlowPackage', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-lint-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  // ── TC-009 ────────────────────────────────────────────────────────────────
  // Five required README sections: 'What it does', 'Sample output',
  // 'Estimated cost and duration', 'Install', 'Run'.
  // A README missing exactly one must produce exactly one section error for
  // that section, and no section errors for the four present sections.

  it('[TC-009] README missing "Sample output" produces exactly one section error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');

    // Remove "Sample output" section from the README
    const readmeWithout = FULL_README.replace(/^## Sample output[\s\S]*?(?=^## )/m, '');
    await writeFile(join(tmp, 'README.md'), readmeWithout, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    // Exactly one error with code README_MISSING_SAMPLE_OUTPUT
    const sampleOutputErrors = report.errors.filter(
      (f) => f.code === 'README_MISSING_SAMPLE_OUTPUT',
    );
    expect(sampleOutputErrors).toHaveLength(1);

    // The other four required sections must not produce errors
    const otherSectionErrorCodes = [
      'README_MISSING_WHAT_IT_DOES',
      'README_MISSING_COST_DURATION',
      'README_MISSING_INSTALL',
      'README_MISSING_RUN',
    ];
    const otherSectionErrors = report.errors.filter((f) => otherSectionErrorCodes.includes(f.code));
    expect(otherSectionErrors).toHaveLength(0);
  });

  it('[TC-009] README missing "What it does" produces exactly one section error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');

    const readmeWithout = FULL_README.replace(/^## What it does[\s\S]*?(?=^## )/m, '');
    await writeFile(join(tmp, 'README.md'), readmeWithout, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const errors = report.errors.filter((f) => f.code === 'README_MISSING_WHAT_IT_DOES');
    expect(errors).toHaveLength(1);

    const absent = report.errors.filter((f) =>
      [
        'README_MISSING_SAMPLE_OUTPUT',
        'README_MISSING_COST_DURATION',
        'README_MISSING_INSTALL',
        'README_MISSING_RUN',
      ].includes(f.code),
    );
    expect(absent).toHaveLength(0);
  });

  it('[TC-009] README missing "Estimated cost and duration" produces exactly one section error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');

    const readmeWithout = FULL_README.replace(
      /^## Estimated cost and duration[\s\S]*?(?=^## )/m,
      '',
    );
    await writeFile(join(tmp, 'README.md'), readmeWithout, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const errors = report.errors.filter((f) => f.code === 'README_MISSING_COST_DURATION');
    expect(errors).toHaveLength(1);

    const absent = report.errors.filter((f) =>
      [
        'README_MISSING_WHAT_IT_DOES',
        'README_MISSING_SAMPLE_OUTPUT',
        'README_MISSING_INSTALL',
        'README_MISSING_RUN',
      ].includes(f.code),
    );
    expect(absent).toHaveLength(0);
  });

  it('[TC-009] README missing "Install" produces exactly one section error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');

    // "Run" comes after "Install" and is the last section — remove Install block up to Run
    const readmeWithout = FULL_README.replace(/^## Install[\s\S]*?(?=^## Run)/m, '');
    await writeFile(join(tmp, 'README.md'), readmeWithout, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const errors = report.errors.filter((f) => f.code === 'README_MISSING_INSTALL');
    expect(errors).toHaveLength(1);

    const absent = report.errors.filter((f) =>
      [
        'README_MISSING_WHAT_IT_DOES',
        'README_MISSING_SAMPLE_OUTPUT',
        'README_MISSING_COST_DURATION',
        'README_MISSING_RUN',
      ].includes(f.code),
    );
    expect(absent).toHaveLength(0);
  });

  it('[TC-009] README missing "Run" produces exactly one section error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');

    const readmeWithout = FULL_README.replace(/^## Run[\s\S]*/m, '');
    await writeFile(join(tmp, 'README.md'), readmeWithout, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const errors = report.errors.filter((f) => f.code === 'README_MISSING_RUN');
    expect(errors).toHaveLength(1);

    const absent = report.errors.filter((f) =>
      [
        'README_MISSING_WHAT_IT_DOES',
        'README_MISSING_SAMPLE_OUTPUT',
        'README_MISSING_COST_DURATION',
        'README_MISSING_INSTALL',
      ].includes(f.code),
    );
    expect(absent).toHaveLength(0);
  });

  // ── TC-010 ────────────────────────────────────────────────────────────────
  // The linter scans flow.ts (or dist/flow.js) for the string `promptFile`.
  // When found and prompts/ does not exist, it must emit PROMPTS_DIR_MISSING.

  it('[TC-010] missing prompts/ directory flagged as error when flow.ts uses promptFile', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_PROMPT_FILE_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');
    // Intentionally do NOT create prompts/ directory

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const promptErrors = report.errors.filter((f) => f.code === 'PROMPTS_DIR_MISSING');
    expect(promptErrors).toHaveLength(1);
    expect(promptErrors[0]?.message).toContain('promptFile');
    expect(promptErrors[0]?.message).toContain('prompts/');
  });

  it('[TC-010] no prompts/ error when flow.ts does not reference promptFile', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');
    // No prompts/ directory — should not matter since flow.ts has no promptFile

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const promptErrors = report.errors.filter((f) => f.code === 'PROMPTS_DIR_MISSING');
    expect(promptErrors).toHaveLength(0);
  });

  it('[TC-010] no prompts/ error when flow.ts uses promptFile but prompts/ exists', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson(), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_PROMPT_FILE_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');
    await mkdir(join(tmp, 'prompts'));

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const promptErrors = report.errors.filter((f) => f.code === 'PROMPTS_DIR_MISSING');
    expect(promptErrors).toHaveLength(0);
  });

  // ── TC-011 ────────────────────────────────────────────────────────────────
  // Malformed relay metadata block fields produce targeted errors.

  it('[TC-011a] flat number for estimatedCostUsd produces PKG_MISSING_COST error', async () => {
    await writeFile(join(tmp, 'package.json'), validPackageJson({ estimatedCostUsd: 0.5 }), 'utf8');
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const costErrors = report.errors.filter((f) => f.code === 'PKG_MISSING_COST');
    expect(costErrors).toHaveLength(1);
    expect(costErrors[0]?.message.toLowerCase()).toContain('estimatedcostusd');
  });

  it('[TC-011b] string instead of array for tags produces PKG_MISSING_TAGS error', async () => {
    await writeFile(
      join(tmp, 'package.json'),
      // Write JSON directly to bypass TypeScript — the linter receives raw JSON
      JSON.stringify(
        {
          name: 'test-flow',
          version: '1.0.0',
          type: 'module',
          main: 'flow.js',
          relay: { ...validRelayBlock(), tags: 'not-an-array' },
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const tagErrors = report.errors.filter((f) => f.code === 'PKG_MISSING_TAGS');
    expect(tagErrors).toHaveLength(1);
    expect(tagErrors[0]?.message.toLowerCase()).toContain('tags');
  });

  it('[TC-011c] missing displayName in relay block produces PKG_MISSING_DISPLAY_NAME error', async () => {
    const relayWithoutDisplayName = { ...validRelayBlock() };
    delete relayWithoutDisplayName.displayName;

    await writeFile(
      join(tmp, 'package.json'),
      JSON.stringify(
        {
          name: 'test-flow',
          version: '1.0.0',
          type: 'module',
          main: 'flow.js',
          relay: relayWithoutDisplayName,
        },
        null,
        2,
      ),
      'utf8',
    );
    await writeFile(join(tmp, 'flow.ts'), FLOW_TS_STUB, 'utf8');
    await writeFile(join(tmp, 'README.md'), FULL_README, 'utf8');

    const result = await lintFlowPackage(tmp);
    expect(result.isOk()).toBe(true);
    const report = result._unsafeUnwrap();

    const displayNameErrors = report.errors.filter((f) => f.code === 'PKG_MISSING_DISPLAY_NAME');
    expect(displayNameErrors).toHaveLength(1);
    expect(displayNameErrors[0]?.message.toLowerCase()).toContain('displayname');
  });
});
