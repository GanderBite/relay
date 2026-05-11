/**
 * Smoke tests for buildProgram() — the Commander program factory.
 *
 * These tests exercise the dispatcher layer in-process without spawning a
 * subprocess and without loading any command handlers.
 *
 * Design note on did-you-mean suggestion reachability
 * ---------------------------------------------------
 * The dispatcher registers a root-level .action() handler (the flow-name
 * shorthand and splash-help fallback). Commander's internal _parseCommand
 * evaluates `if (this._actionHandler)` before the `unknownCommand()` branch,
 * so a mistyped subcommand name (e.g. 'rsume') is consumed by the root action
 * path rather than the unknownCommand() path. The root action has no declared
 * positional arguments, so Commander emits "too many arguments" via
 * _excessArguments() — the unknownCommand() / suggestSimilar() branch is
 * structurally unreachable at root level.
 *
 * showSuggestionAfterError(true) IS reachable for mistyped options (e.g.
 * 'relay --verbos' suggests '--verbose') because checkForUnknownOptions() runs
 * inside the _actionHandler branch before the action is invoked.
 *
 * The tests below assert the actually-reachable behaviour rather than the
 * conceptual "relay rsume → Did you mean resume?" scenario from the finding.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../src/dispatcher.js';

describe('buildProgram — unknown input error messages', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
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

  it('emits a too-many-arguments error when a near-miss subcommand name is used at root level', async () => {
    // Because the root program registers a .action() handler, Commander routes
    // 'rsume' through _processArguments() rather than unknownCommand(). The
    // result is "too many arguments" not "unknown command / did you mean".
    // This test locks in the actual current behaviour so a refactor that
    // accidentally changes the error text is caught.
    try {
      await buildProgram().parseAsync(['node', 'relay', 'rsume']);
    } catch {
      // expected — Commander throws CommanderError via exitOverride()
    }

    const output = capturedStderr();
    expect(output).toContain('error: too many arguments');
  });
});
