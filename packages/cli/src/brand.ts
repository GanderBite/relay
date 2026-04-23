/**
 * Brand constants for the Relay CLI.
 *
 * Pure constants only — zero side effects, no imports from chalk or settings.
 * This module is safe to import from any context, including test environments
 * where the settings file is absent and chalk is not initialized.
 *
 * Voice rules (product spec §4.1–§4.2):
 *   - "simply" is banned. No trailing exclamation marks. No emojis.
 *   - Numbers over adjectives: "2.1s" beats "quickly", "$0.38" beats "low cost".
 *
 * Symbol vocabulary (product spec §4.3): fixed set, never add without spec change.
 */

// ---------------------------------------------------------------------------
// The mark and wordmark (product spec §5.1, §5.3)
// ---------------------------------------------------------------------------

/** The Relay signature mark. Four nodes, three arrows. */
export const MARK = '●─▶●─▶●─▶●';

/**
 * The Relay wordmark. Two spaces between mark and name (product spec §5.3).
 * Always lowercase "relay" in the wordmark.
 */
export const WORDMARK = '●─▶●─▶●─▶●  relay';

// ---------------------------------------------------------------------------
// Symbol vocabulary (product spec §4.3)
//
// These are Unicode characters, not emoji. The symbol set is fixed — never
// add a symbol here that is not in the product spec vocabulary.
// ---------------------------------------------------------------------------

export const SYMBOLS = {
  /** Step or check succeeded. */
  ok: '✓',
  /** Step or check failed. */
  fail: '✕',
  /** Warning — user should read. */
  warn: '⚠',
  /** Spinner frames — step is running. Advance index on each tick. */
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const,
  /** Pending — step has not started. */
  pending: '○',
  /** Separator. */
  dot: '·',
  /** Arrow / flow direction. */
  arrow: '▶',
  /** Cancelled or paused mid-step. */
  cancelled: '⊘',
} as const;

// ---------------------------------------------------------------------------
// Brand composition helpers
//
// These functions compose brand constants into display strings. They have zero
// side effects and no imports from chalk or settings — safe to call anywhere.
// ---------------------------------------------------------------------------

/**
 * Compose a banner header line from flow name, run id, and an optional status symbol.
 * Produces: `●─▶●─▶●─▶●  <flowName> · <runId>  <symbol>` (symbol omitted when absent).
 *
 * Use this instead of string-replacing WORDMARK, which breaks when flow names
 * contain "relay" or when WORDMARK changes.
 *
 * Examples (product spec §6.5, §6.6):
 *   flowHeader('codebase-discovery', 'f9c3a2', '✓')
 *   → '●─▶●─▶●─▶●  codebase-discovery · f9c3a2  ✓'
 */
export function flowHeader(flowName: string, runId: string, symbol?: string): string {
  const base = `${MARK}  ${flowName} ${SYMBOLS.dot} ${runId}`;
  return symbol !== undefined ? `${base}  ${symbol}` : base;
}
