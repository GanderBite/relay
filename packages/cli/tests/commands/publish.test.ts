/**
 * Tests for `relay publish <path>` command.
 *
 * Smoke tests only — verifies that the command does not throw on valid input
 * and that key early-exit paths (missing arg, lint errors) behave correctly.
 * All I/O, lint, registry, and npm subprocess calls are mocked.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks before module-under-test imports resolve.
// ---------------------------------------------------------------------------

const mockReadFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
const mockExecFile = vi.hoisted(() => vi.fn());
const mockLintRacePackage = vi.hoisted(() => vi.fn());
const mockGenerateRegistryJson = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: (...args: unknown[]) => mockReadFile(...args),
  };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: (...args: unknown[]) => mockExecFile(...args),
  };
});

vi.mock('../../src/lint.js', () => ({
  lintRacePackage: (...args: unknown[]) => mockLintRacePackage(...args),
}));

vi.mock('../../src/registry.js', () => ({
  generateRegistryJson: (...args: unknown[]) => mockGenerateRegistryJson(...args),
}));

// ---------------------------------------------------------------------------
// Imports after mock registration.
// ---------------------------------------------------------------------------

import { err, ok } from '@ganderbite/relay-core';
import publishCommand from '../../src/commands/publish.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCleanLintReport() {
  return { warnings: [], errors: [] };
}

function makePkgJson(name = '@ganderbite/flow-my-flow', version = '0.1.0'): string {
  return JSON.stringify({ name, version, scripts: {} });
}

function captureWrites(spy: ReturnType<typeof vi.spyOn>): string {
  return (spy as ReturnType<typeof vi.fn>).mock.calls.map((c: unknown[]) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();

  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`process.exit:${String(code)}`);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Missing argument
// ---------------------------------------------------------------------------

describe('relay publish — missing argument', () => {
  it('[PUB-001] exits 1 with usage hint when no path is provided', async () => {
    await expect(publishCommand([], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('usage: relay publish <path>');
  });
});

// ---------------------------------------------------------------------------
// Lint failure
// ---------------------------------------------------------------------------

describe('relay publish — lint failure', () => {
  it('[PUB-002] exits 1 when lint returns errors', async () => {
    mockLintRacePackage.mockResolvedValue(
      ok({
        warnings: [],
        errors: [{ message: 'missing relay metadata block', path: 'package.json' }],
      }),
    );
    mockReadFile.mockResolvedValue(makePkgJson());

    await expect(publishCommand(['/tmp/my-flow'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('lint');
  });

  it('[PUB-003] exits 1 when lintRacePackage itself returns an error result', async () => {
    mockLintRacePackage.mockResolvedValue(err(new Error('directory not found')));
    mockReadFile.mockResolvedValue(makePkgJson());

    await expect(publishCommand(['/tmp/my-flow'], {})).rejects.toThrow('process.exit:1');

    expect(process.exit).toHaveBeenCalledWith(1);
    const stderr = captureWrites(process.stderr.write as ReturnType<typeof vi.spyOn>);
    expect(stderr).toContain('lint failed');
  });
});

// ---------------------------------------------------------------------------
// Smoke test — dry-run succeeds
// ---------------------------------------------------------------------------

describe('relay publish — dry-run smoke test', () => {
  it('[PUB-004] dry-run with clean lint, no build script, succeeds and prints published name', async () => {
    mockLintRacePackage.mockResolvedValue(ok(makeCleanLintReport()));

    // readFile: first call is readBuildScript (no build script → scripts block empty),
    // second call is readPackageMeta.
    mockReadFile.mockResolvedValue(makePkgJson());

    // npm publish --dry-run: execFile resolves with empty stdout.
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: Function) => {
        cb(null, { stdout: '', stderr: '' });
      },
    );

    // Registry generation: returns an ok result with a matching entry.
    mockGenerateRegistryJson.mockResolvedValue(
      ok({
        version: 1,
        flows: [{ name: '@ganderbite/flow-my-flow', version: '0.1.0' }],
      }),
    );

    // Should not throw (dry-run does not exit non-zero on success).
    await publishCommand(['/tmp/my-flow'], { dryRun: true });

    const stdout = captureWrites(process.stdout.write as ReturnType<typeof vi.spyOn>);
    expect(stdout).toContain('published');
    expect(stdout).toContain('@ganderbite/flow-my-flow');
  });
});
