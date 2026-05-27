/**
 * Compile-time-friendly lock that every ERROR_CODES value from
 * @ganderbite/relay-core is either registered in errorRegistry or
 * explicitly acknowledged as intentionally unmapped.
 *
 * The test fails when a new code is added to relay-core without
 * classifying it here, preventing the mapping comment block in
 * registry.ts from silently going out of date.
 */

import { ERROR_CODES } from '@ganderbite/relay-core';
import { describe, expect, it } from 'vitest';
import { errorRegistry } from '../../src/exit-codes.js';

// ---------------------------------------------------------------------------
// Codes that intentionally have no registry entry.
//
// These codes are handled by the exitCodeFor fallback (exit 1) because their
// error classes do not require a custom formatted output block — they surface
// operator-facing diagnostics via the generic PipelineError fallback renderer
// or are internal control-flow signals that the user rarely sees in practice.
//
// When adding a new code here, explain WHY it is not registered.
// ---------------------------------------------------------------------------

const KNOWN_UNMAPPED: ReadonlySet<string> = new Set([
  ERROR_CODES.ATOMIC_WRITE,
  // Wraps low-level rename(2) failures; no actionable remediation beyond
  // checking disk space / permissions. Falls through to exit 1.

  ERROR_CODES.HANDOFF_IO,
  // Filesystem read/list error inside HandoffStore. Operator needs the raw
  // cause text which the generic fallback provides; no bespoke formatter.

  ERROR_CODES.HANDOFF_NOT_FOUND,
  // ENOENT on a specific handoff file. The generic PipelineError fallback
  // suffices; the operator already has the handoff id from the message.

  ERROR_CODES.HANDOFF_OUTPUT,
  // Post-invocation output-file missing or malformed — this is retryable and
  // the retry loop normally catches it before the CLI sees it. Falls through.

  ERROR_CODES.HANDOFF_WRITE,
  // Atomic-write failure for a handoff file. Same reasoning as ATOMIC_WRITE:
  // no custom remediation beyond disk/permissions advice.

  ERROR_CODES.METRICS_WRITE,
  // metrics.json persistence failure. Non-fatal in most workflows; the run
  // result is still available. No dedicated formatter added.

  ERROR_CODES.STATE_CORRUPT,
  // state.json parse or validation failure. Operator should inspect the file
  // manually; the generic fallback includes the code for `grep`.

  ERROR_CODES.STATE_NOT_FOUND,
  // state.json absent — indicates a fresh (not resumable) run directory.
  // The caller handles this case before it reaches the CLI error handler.

  ERROR_CODES.STATE_TRANSITION,
  // Illegal StateMachine transition — programmer error, not operator error.
  // The stack trace is more useful than a formatted block.

  ERROR_CODES.STATE_VERSION_MISMATCH,
  // Flow name/version changed between runs. The generic block includes the
  // code; a future sprint may add a dedicated formatter.

  ERROR_CODES.STATE_WRITE,
  // state.json atomic-write failure. Same as ATOMIC_WRITE / HANDOFF_WRITE:
  // no actionable remediation beyond checking the run directory.

  ERROR_CODES.AGENTS_RESOLUTION,
  // Agent graph validation failure before any invocation. The generic
  // PipelineError fallback includes the message with the resolution details.
]);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('errorRegistry ERROR_CODES coverage', () => {
  it('registry is non-empty', () => {
    expect(errorRegistry.size).toBeGreaterThan(0);
  });

  it('at least one known-mapped code is present in the registry', () => {
    // Positive baseline: STEP_FAILURE is always expected to be registered.
    expect(errorRegistry.has(ERROR_CODES.STEP_FAILURE)).toBe(true);
  });

  it('every ERROR_CODES value is either registered or in KNOWN_UNMAPPED', () => {
    const allCodes = Object.values(ERROR_CODES) as string[];
    const unclassified: string[] = [];

    for (const code of allCodes) {
      if (!errorRegistry.has(code) && !KNOWN_UNMAPPED.has(code)) {
        unclassified.push(code);
      }
    }

    expect(
      unclassified,
      `The following error codes are not in errorRegistry and not listed in KNOWN_UNMAPPED: ` +
        `[${unclassified.join(', ')}]. ` +
        `Add a registry entry in packages/cli/src/errors/registry.ts OR add the code to ` +
        `KNOWN_UNMAPPED in this test with a justification comment.`,
    ).toHaveLength(0);
  });

  it('no code appears in both errorRegistry and KNOWN_UNMAPPED', () => {
    const conflicts: string[] = [];

    for (const code of KNOWN_UNMAPPED) {
      if (errorRegistry.has(code)) {
        conflicts.push(code);
      }
    }

    expect(
      conflicts,
      `The following codes appear in both errorRegistry and KNOWN_UNMAPPED: ` +
        `[${conflicts.join(', ')}]. Remove them from KNOWN_UNMAPPED.`,
    ).toHaveLength(0);
  });

  it('KNOWN_UNMAPPED contains only real ERROR_CODES values', () => {
    const allCodes = new Set<string>(Object.values(ERROR_CODES));
    const stale: string[] = [];

    for (const code of KNOWN_UNMAPPED) {
      if (!allCodes.has(code)) {
        stale.push(code);
      }
    }

    expect(
      stale,
      `The following entries in KNOWN_UNMAPPED are not in ERROR_CODES (stale after a rename?): ` +
        `[${stale.join(', ')}]. Remove them.`,
    ).toHaveLength(0);
  });
});
