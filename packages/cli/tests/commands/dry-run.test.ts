/**
 * Tests for `relay dry-run` command.
 *
 * The command loads a flow, validates it, renders a step plan, and redacts
 * sensitive env values. All I/O is mocked — no live Claude calls, no real disk.
 *
 * Exit codes:
 *   0 — valid flow, plan printed
 *   1 — FlowLoadError
 *   2 — FlowDefinitionError or input parse error
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Hoist mocks so they are registered before module-under-test imports.
// ---------------------------------------------------------------------------

const mockLoadFlow = vi.hoisted(() => vi.fn());
const mockParseInputFromArgv = vi.hoisted(() => vi.fn());

vi.mock('../../src/flow-loader.js', () => ({
  loadFlow: (...args: unknown[]) => mockLoadFlow(...args),
  FlowLoadError: class FlowLoadError extends Error {
    code: string;
    constructor(msg: string, code: string) {
      super(msg);
      this.name = 'FlowLoadError';
      this.code = code;
    }
  },
}));

vi.mock('../../src/input-parser.js', () => ({
  parseInputFromArgv: (...args: unknown[]) => mockParseInputFromArgv(...args),
}));

// Mock node:fs/promises access so prompt-file existence checks do not hit disk.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    access: vi.fn().mockResolvedValue(undefined),
  };
});

// ---------------------------------------------------------------------------
// Imports — after vi.mock calls.
// ---------------------------------------------------------------------------

import { err, FlowDefinitionError, ok } from '@ganderbite/relay-core';
import dryRunCommand from '../../src/commands/dry-run.js';
import { FlowLoadError } from '../../src/flow-loader.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScriptStep(id: string, run: string, env?: Record<string, string>) {
  return { id, kind: 'script' as const, run, ...(env !== undefined ? { env } : {}) };
}

function makeFlowWithScriptStep(stepId: string, run: string, env?: Record<string, string>) {
  const step = makeScriptStep(stepId, run, env);
  return {
    name: 'my-flow',
    version: '1.0.0',
    steps: { [stepId]: step },
    stepOrder: [stepId],
    graph: {
      topoOrder: [stepId],
      rootSteps: [stepId],
      predecessors: new Map(),
      successors: new Map(),
    },
    input: undefined,
  };
}

function makeFlowWithPromptStep(stepId: string, promptFile: string) {
  const step = { id: stepId, kind: 'prompt' as const, promptFile };
  return {
    name: 'my-flow',
    version: '1.0.0',
    steps: { [stepId]: step },
    stepOrder: [stepId],
    graph: {
      topoOrder: [stepId],
      rootSteps: [stepId],
      predecessors: new Map(),
      successors: new Map(),
    },
    input: undefined,
  };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let stdoutOutput: string;
let stderrOutput: string;

beforeEach(() => {
  stdoutOutput = '';
  stderrOutput = '';

  vi.spyOn(process.stdout, 'write').mockImplementation((s: unknown) => {
    stdoutOutput += String(s);
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s: unknown) => {
    stderrOutput += String(s);
    return true;
  });
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('process.exit called');
  });

  // Default: input parse always succeeds with empty data.
  mockParseInputFromArgv.mockReturnValue(ok({}));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay dry-run — step plan rendering', () => {
  it('[DRY-001] prints flow name in the plan header', async () => {
    const flow = makeFlowWithScriptStep('build', 'make build');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('my-flow');
    expect(process.exit).toHaveBeenCalledWith(0);
  });

  it('[DRY-002] prints "dry-run" in the plan header', async () => {
    const flow = makeFlowWithScriptStep('build', 'make build');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('dry-run');
  });

  it('[DRY-003] prints step id in the plan', async () => {
    const flow = makeFlowWithScriptStep('install-deps', 'npm install');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('install-deps');
  });

  it('[DRY-004] prints the run command in the step block', async () => {
    const flow = makeFlowWithScriptStep('compile', 'tsc --noEmit');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('tsc --noEmit');
  });

  it('[DRY-005] prints "script" kind label', async () => {
    const flow = makeFlowWithScriptStep('run-lint', 'eslint src');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('script');
  });

  it('[DRY-006] prints prompt file path for prompt steps', async () => {
    const flow = makeFlowWithPromptStep('analyze', '/prompts/analyze.md');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('/prompts/analyze.md');
    expect(stdoutOutput).toContain('prompt');
  });
});

describe('relay dry-run — env secret redaction', () => {
  it('[DRY-010] env key containing "token" is redacted to "[redacted]"', async () => {
    const flow = makeFlowWithScriptStep('deploy', './deploy.sh', {
      GITHUB_TOKEN: 'ghp_supersecret',
      NODE_ENV: 'production',
    });
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('[redacted]');
    expect(stdoutOutput).not.toContain('ghp_supersecret');
  });

  it('[DRY-011] env key containing "secret" is redacted', async () => {
    const flow = makeFlowWithScriptStep('push', './push.sh', {
      AWS_SECRET_ACCESS_KEY: 'deadbeef',
    });
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('[redacted]');
    expect(stdoutOutput).not.toContain('deadbeef');
  });

  it('[DRY-012] env key containing "key" is redacted', async () => {
    const flow = makeFlowWithScriptStep('sign', './sign.sh', {
      SIGNING_KEY: 'abc123',
    });
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('[redacted]');
    expect(stdoutOutput).not.toContain('abc123');
  });

  it('[DRY-013] env key containing "password" is redacted', async () => {
    const flow = makeFlowWithScriptStep('db-migrate', './migrate.sh', {
      DB_PASSWORD: 'hunter2',
    });
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('[redacted]');
    expect(stdoutOutput).not.toContain('hunter2');
  });

  it('[DRY-014] non-sensitive env values are printed in clear text', async () => {
    const flow = makeFlowWithScriptStep('build', 'make', {
      NODE_ENV: 'production',
      WORKERS: '4',
    });
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('NODE_ENV=production');
    expect(stdoutOutput).toContain('WORKERS=4');
  });

  it('[DRY-015] step with no env block renders no env section', async () => {
    const flow = makeFlowWithScriptStep('check', 'echo ok');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).not.toContain('[redacted]');
    expect(process.exit).toHaveBeenCalledWith(0);
  });
});

describe('relay dry-run — step summary footer', () => {
  it('[DRY-020] footer includes total step count', async () => {
    const flow = makeFlowWithScriptStep('step1', 'echo one');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));

    await expect(dryRunCommand(['my-flow'], {})).rejects.toThrow('process.exit called');

    expect(stdoutOutput).toContain('1 step');
  });
});

describe('relay dry-run — error paths', () => {
  it('[DRY-030] FlowDefinitionError exits 2 and writes message to stderr', async () => {
    const defErr = new FlowDefinitionError('step "missing" unknown');
    mockLoadFlow.mockResolvedValue(err(defErr));

    await expect(dryRunCommand(['bad-flow'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('missing');
    expect(process.exit).toHaveBeenCalledWith(2);
  });

  it('[DRY-031] FlowLoadError (not found) exits 1', async () => {
    const loadErr = new FlowLoadError('flow "no-such" not found', 'FLOW_NOT_FOUND');
    mockLoadFlow.mockResolvedValue(err(loadErr));

    await expect(dryRunCommand(['no-such'], {})).rejects.toThrow('process.exit called');

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('[DRY-032] no flow argument exits 1 and prints usage to stderr', async () => {
    await expect(dryRunCommand([], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('usage');
    expect(stderrOutput).toContain('relay dry-run');
    expect(process.exit).toHaveBeenCalledWith(1);
    expect(mockLoadFlow).not.toHaveBeenCalled();
  });

  it('[DRY-033] input parse error exits 2 and writes message to stderr', async () => {
    const flow = makeFlowWithScriptStep('build', 'make');
    mockLoadFlow.mockResolvedValue(ok({ flow, dir: '/tmp/my-flow' }));
    mockParseInputFromArgv.mockReturnValue(err(new Error('required input field "target" missing')));

    await expect(dryRunCommand(['my-flow', '--target'], {})).rejects.toThrow('process.exit called');

    expect(stderrOutput).toContain('target');
    expect(process.exit).toHaveBeenCalledWith(2);
  });
});
