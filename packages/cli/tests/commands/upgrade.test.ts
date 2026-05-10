/**
 * Tests for `relay upgrade [flow]` command.
 *
 * Covers:
 *  - renderOutcome: all four branches (updated upgrade, updated downgrade, current, failed)
 *  - upgradeCommand: no flows installed exits 0
 *  - upgradeCommand: target flow not installed exits 1
 *  - upgradeCommand: successful upgrade prints diff row
 *
 * All filesystem I/O and installCommand are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockReaddir = vi.hoisted(() => vi.fn());
const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockInstallCommand = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: (...args: unknown[]) => mockReaddir(...args),
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

vi.mock('../../src/commands/install.js', () => ({
  default: (...args: unknown[]) => mockInstallCommand(...args),
}));

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import upgradeCommand, { renderOutcome, type UpgradeOutcome } from '../../src/commands/upgrade.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOutcome(overrides: Partial<UpgradeOutcome>): UpgradeOutcome {
  return {
    name: 'my-flow',
    status: 'updated',
    before: '0.1.0',
    after: '0.1.1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stdoutOutput: string;

beforeEach(() => {
  stdoutOutput = '';

  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutOutput += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });

  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// renderOutcome — unit tests for the exported helper
// ---------------------------------------------------------------------------

describe('renderOutcome', () => {
  it('[UPG-001] status:updated with semver upgrade renders green arrow and new version', () => {
    const line = renderOutcome(makeOutcome({ status: 'updated', before: '0.1.0', after: '0.1.1' }));
    expect(line).toContain('v0.1.0');
    expect(line).toContain('v0.1.1');
    // Must contain the arrow character.
    expect(line).toContain('→');
  });

  it('[UPG-002] status:current renders "up to date" and the current version', () => {
    const line = renderOutcome(makeOutcome({ status: 'current', before: '0.2.1', after: '0.2.1' }));
    expect(line).toContain('up to date');
    expect(line).toContain('v0.2.1');
    // The dot separator is used for current state.
    expect(line).toContain('·');
  });

  it('[UPG-003] status:failed renders "failed:" with the reason', () => {
    const line = renderOutcome(
      makeOutcome({ status: 'failed', reason: 'network timeout', before: '0.1.0', after: '0.1.0' }),
    );
    expect(line).toContain('failed:');
    expect(line).toContain('network timeout');
    expect(line).toContain('✕');
  });

  it('[UPG-004] status:updated with downgrade (after < before) uses fail symbol styling', () => {
    // Downgrade: after version is older than before.
    const line = renderOutcome(makeOutcome({ status: 'updated', before: '0.2.0', after: '0.1.0' }));
    expect(line).toContain('v0.2.0');
    expect(line).toContain('v0.1.0');
    // Downgrade renders with ✓ symbol in red (still has the ok symbol per source).
    expect(line).toContain('✓');
  });
});

// ---------------------------------------------------------------------------
// upgradeCommand — integration-level tests with mocked install
// ---------------------------------------------------------------------------

describe('relay upgrade — no flows installed', () => {
  it('[UPG-010] exits 0 with "no flows installed" message when .relay/flows is empty', async () => {
    mockReaddir.mockResolvedValue([]);

    await expect(upgradeCommand([], {})).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(stdoutOutput).toContain('no flows installed');
  });

  it('[UPG-011] exits 0 when .relay/flows directory does not exist', async () => {
    mockReaddir.mockRejectedValue(new Error('ENOENT'));

    await expect(upgradeCommand([], {})).rejects.toThrow('process.exit:0');

    expect(process.exit).toHaveBeenCalledWith(0);
    expect(stdoutOutput).toContain('no flows installed');
  });
});

describe('relay upgrade — target flow not installed', () => {
  it('[UPG-012] exits 1 when the specified flow is not in .relay/flows', async () => {
    // Only "other-flow" is installed, not "my-flow".
    mockReaddir.mockResolvedValue([{ name: 'other-flow', isDirectory: () => true }]);

    await expect(upgradeCommand(['my-flow'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stdoutOutput).toContain('my-flow');
    expect(stdoutOutput).toContain('not installed');
  });
});

describe('relay upgrade — successful single-flow upgrade', () => {
  it('[UPG-013] upgraded flow diff row appears on stdout with before/after versions', async () => {
    mockReaddir.mockResolvedValue([{ name: 'my-flow', isDirectory: () => true }]);
    // readFile returns the version before install, then after install.
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ name: 'my-flow', version: '0.1.0' }))
      .mockResolvedValueOnce(JSON.stringify({ name: 'my-flow', version: '0.1.1' }));
    mockInstallCommand.mockResolvedValue(undefined);

    // Single-flow success: upgradeCommand returns normally (no process.exit call).
    await expect(upgradeCommand(['my-flow'], {})).resolves.toBeUndefined();

    expect(stdoutOutput).toContain('v0.1.0');
    expect(stdoutOutput).toContain('v0.1.1');
    expect(stdoutOutput).toContain('→');
  });
});

describe('relay upgrade — all-flows upgrade with failure', () => {
  it('[UPG-014] exits 1 when one flow fails to upgrade', async () => {
    mockReaddir.mockResolvedValue([
      { name: 'flow-a', isDirectory: () => true },
      { name: 'flow-b', isDirectory: () => true },
    ]);
    // flow-a: stable
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ version: '0.1.0' }))
      .mockResolvedValueOnce(JSON.stringify({ version: '0.1.0' }))
      // flow-b: same version before and after
      .mockResolvedValueOnce(JSON.stringify({ version: '0.2.0' }))
      .mockResolvedValueOnce(JSON.stringify({ version: '0.2.0' }));

    // flow-a install succeeds, flow-b install throws.
    mockInstallCommand
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('registry unreachable'));

    await expect(upgradeCommand([], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    expect(stdoutOutput).toContain('failed:');
    expect(stdoutOutput).toContain('registry unreachable');
  });
});
