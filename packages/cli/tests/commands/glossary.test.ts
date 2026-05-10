/**
 * Tests for `relay help glossary` command.
 *
 * The command prints the five-term Relay glossary to stdout and exits 0.
 * All I/O is captured via process.stdout spy — no disk or network access.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import glossaryCommand from '../../src/commands/glossary.js';

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
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('relay help glossary — output content', () => {
  it('[GLO-001] prints the brand mark in the header', async () => {
    await glossaryCommand([], {});

    expect(stdoutOutput).toContain('●─▶●─▶●─▶●');
  });

  it('[GLO-002] prints "glossary" in the header', async () => {
    await glossaryCommand([], {});

    expect(stdoutOutput).toContain('glossary');
  });

  it('[GLO-003] output contains all five canonical terms', async () => {
    await glossaryCommand([], {});

    expect(stdoutOutput).toContain('flow');
    expect(stdoutOutput).toContain('step');
    expect(stdoutOutput).toContain('handoff');
    expect(stdoutOutput).toContain('run');
    expect(stdoutOutput).toContain('checkpoint');
  });

  it('[GLO-004] output contains definitions for the five terms', async () => {
    await glossaryCommand([], {});

    expect(stdoutOutput).toContain('a named, versioned sequence of steps you can run');
    expect(stdoutOutput).toContain('one node in a flow');
    expect(stdoutOutput).toContain('the JSON one step produces and a later step consumes');
    expect(stdoutOutput).toContain('one execution of a flow');
    expect(stdoutOutput).toContain('the saved state of a run after each step completes');
  });

  it('[GLO-005] snapshot matches full output', async () => {
    await glossaryCommand([], {});

    expect(stdoutOutput).toMatchSnapshot();
  });
});
