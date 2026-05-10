/**
 * exitCodeFor and formatError — the two public dispatch functions that
 * translate a thrown value into a CLI exit code and a formatted error block.
 *
 * Output shape:
 *   ✕ <headline>          <- red
 *
 *     <explanation>       <- plain, two-space indent
 *
 *     → <command>         <- one per remediation, two-space indent
 *
 * Every shape ends with at least one → line — no dead-ends.
 */

import { PipelineError } from '@ganderbite/relay-core';
import { CommanderError } from 'commander';
import { gray, red } from '../color.js';
import { EXIT_CODES } from './codes.js';
import { BLANK, INDENT, remediation } from './helpers.js';
import { errorRegistry } from './registry.js';

/**
 * Map any thrown value to a CLI exit code.
 */
export function exitCodeFor(err: unknown): number {
  if (err instanceof CommanderError) return err.exitCode;
  if (err instanceof PipelineError) {
    const entry = errorRegistry.get(err.code);
    if (entry !== undefined) return entry.exitCode;
    console.error('relay: unmapped error code ' + err.code + ' — defaulting to exit 1');
    return EXIT_CODES.runner_failure;
  }
  if (err instanceof Error) return EXIT_CODES.runner_failure;
  return EXIT_CODES.runner_failure;
}

/**
 * Produce a fully-formatted multi-line error block for stderr.
 */
export function formatError(err: unknown): string {
  // ----------------------------------------------------------------
  // CommanderError — unknown command or option
  // ----------------------------------------------------------------
  if (err instanceof CommanderError) {
    return [
      red(`✕ Unknown command or option: ${err.message}`),
      BLANK,
      remediation('relay --help'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // PipelineError — look up the registry by error code
  // ----------------------------------------------------------------
  if (err instanceof PipelineError) {
    const handler = errorRegistry.get(err.code);
    if (handler !== undefined) return handler.format(err);

    // Generic PipelineError fallback for unknown codes
    return [
      red(`✕ ${err.name}: ${err.message}`),
      BLANK,
      `${INDENT}A Relay runtime error occurred ${gray(`[${err.code}]`)}.`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // Generic Error
  // ----------------------------------------------------------------
  if (err instanceof Error) {
    return [
      red(`✕ Unexpected error: ${err.message}`),
      BLANK,
      `${INDENT}An unhandled error occurred. This is likely a bug in Relay or a flow package.`,
      BLANK,
      remediation('relay doctor'),
    ].join('\n');
  }

  // ----------------------------------------------------------------
  // Unknown (non-Error throw)
  // ----------------------------------------------------------------
  return [
    red('✕ Unexpected error'),
    BLANK,
    `${INDENT}An unknown value was thrown. This is a bug in a flow package or Relay itself.`,
    BLANK,
    remediation('relay doctor'),
  ].join('\n');
}
