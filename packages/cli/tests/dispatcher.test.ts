/**
 * Smoke tests for buildProgram() — the Commander program factory.
 *
 * These tests exercise the dispatcher layer in-process without spawning a
 * subprocess and without loading any command handlers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/dispatcher.js';

describe('buildProgram — unknown input error messages', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error(`process.exit(${_code})`);
    });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function capturedStderr(): string {
    return stderrSpy.mock.calls.map((args) => String(args[0])).join('');
  }

  it('emits a did-you-mean suggestion for a near-miss option typo', async () => {
    // '--verbos' is one deletion away from '--verbose' — within Commander's
    // Levenshtein threshold (maxDistance = 3, similarity > 0.4).
    // checkForUnknownOptions() runs inside the _actionHandler branch so
    // showSuggestionAfterError is reachable via the unknown-option path.
    try {
      await buildProgram().parseAsync(['node', 'relay', '--verbos']);
    } catch {
      // Commander throws a CommanderError because exitOverride() is set.
      // The stderr write happens before the throw.
    }

    const output = capturedStderr();
    expect(output).toContain('Did you mean --verbose?');
  });

  it('emits the standard unknown-option prefix alongside the suggestion', async () => {
    try {
      await buildProgram().parseAsync(['node', 'relay', '--verbos']);
    } catch {
      // expected
    }

    const output = capturedStderr();
    expect(output).toContain("error: unknown option '--verbos'");
  });

  it('emits a did-you-mean suggestion and exits non-zero for a near-miss subcommand typo', async () => {
    // 'rsume' is one deletion away from 'resume'. The root .action() handler
    // now performs a Levenshtein check before the flow-shorthand fallthrough,
    // routing near-miss typos to a suggestion rather than silently treating
    // them as flow names.
    try {
      await buildProgram().parseAsync(['node', 'relay', 'rsume']);
    } catch {
      // expected — process.exit() is mocked to throw
    }

    const output = capturedStderr();
    expect(output).toContain("error: unknown command 'rsume'. Did you mean 'resume'?");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('does not intercept an exact subcommand name with the typo check', async () => {
    // 'run' is an exact match in KNOWN_COMMANDS and a registered subcommand.
    // The typo check must not fire; Commander should dispatch to the run command.
    // Since we do not mock command handlers here, the run command will throw
    // when it cannot find a flow — but it must NOT emit a did-you-mean message.
    try {
      await buildProgram().parseAsync(['node', 'relay', 'run', 'nonexistent-flow']);
    } catch {
      // expected — run handler will fail without a valid flow path
    }

    const output = capturedStderr();
    expect(output).not.toContain('Did you mean');
  });

  it('does not intercept a path-shaped positional with the typo check', async () => {
    // './examples/hello-world' contains '/' so looksLikePath() returns true.
    // The typo check is skipped for path-shaped positionals; the root action
    // should fall through to the flow-shorthand (run) handler instead.
    // The run handler will fail without a valid flow — that is expected.
    try {
      await buildProgram().parseAsync(['node', 'relay', './examples/hello-world']);
    } catch {
      // expected — run handler will fail without a real flow at that path
    }

    const output = capturedStderr();
    expect(output).not.toContain('Did you mean');
  });
});
