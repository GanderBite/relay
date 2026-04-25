/**
 * Canonical human-readable formatting helpers for the Relay CLI.
 *
 * Single source of truth for all duration, cost, and number formatting.
 * Every CLI module that produces user-visible output imports from here.
 *
 * Boundary behaviours:
 *   fmtDuration(0)      → "0s"
 *   fmtDuration(60000)  → "1m 0s"
 *   fmtDuration(2100)   → "2.1s"   (one decimal for < 10 rounded seconds)
 *   fmtDuration(15000)  → "15s"    (integer for 10s–59s)
 *
 *   fmtCost(0.0042)     → "$0.0042"
 *   fmtCostApprox(0)    → "--"
 *   fmtCostApprox(0.004)→ "~$0.004"
 *
 *   fmtK(999)           → "999"
 *   fmtK(1000)          → "1.0K"
 *   fmtK(12300)         → "12.3K"
 */

// ---------------------------------------------------------------------------
// fmtDuration
// ---------------------------------------------------------------------------

/**
 * Formats a duration in milliseconds as a human-readable string.
 *
 * Rules:
 *   0 ms               → "0s"
 *   < 10 rounded secs  → one decimal place, e.g. "2.1s"
 *   10s – 59s          → integer seconds, e.g. "45s"
 *   60s and above      → minutes and integer seconds, e.g. "1m 0s"
 *
 * Uses Math.round rather than Math.floor so "59.7s" rounds up to "1m 0s"
 * instead of showing "59s", which is more honest about wall-clock time.
 */
export function fmtDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);

  if (totalSec === 0) return '0s';

  if (totalSec < 60) {
    // One decimal for sub-10-second reads — matches spec examples like "2.1s".
    if (totalSec < 10) return `${(ms / 1000).toFixed(1)}s`;
    return `${totalSec}s`;
  }

  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${s}s`;
}

// ---------------------------------------------------------------------------
// fmtCost / fmtCostApprox
// ---------------------------------------------------------------------------

/**
 * Formats an exact cost in USD to 4 decimal places, no ceiling.
 * Example: fmtCost(0.0042) → "$0.0042"
 *
 * Four decimal places because API costs frequently differ at the fourth digit
 * (e.g. $0.0050 vs $0.0045). Showing exactly what was computed, not a rounded
 * or ceiling value, keeps the display honest.
 */
export function fmtCost(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

/**
 * Formats an approximate cost in USD with a tilde prefix.
 * Three decimal places — used for in-flight or estimated values.
 * Returns "--" when usd is exactly 0 (subscription billing has no measurable API cost).
 *
 * Boundary behaviours:
 *   fmtCostApprox(0)     → "--"
 *   fmtCostApprox(0.004) → "~$0.004"
 *
 * The tilde signals "this may change" to the user, so fewer decimal places
 * are appropriate — false precision on an estimate is misleading.
 */
export function fmtCostApprox(usd: number): string {
  if (usd === 0) return '--';
  return `~$${usd.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// fmtK
// ---------------------------------------------------------------------------

/**
 * Formats a number with a compact "K" suffix for thousands.
 *
 * Rules:
 *   n < 1000   → plain integer string, e.g. "999"
 *   n >= 1000  → one decimal place with uppercase K, e.g. "1.0K", "12.3K"
 *
 * Uppercase K matches the product spec examples (§11.3). One decimal place
 * is kept for all K-range values (rather than switching to integer above 10K)
 * so the format is uniform and "12.3K" remains readable.
 */
export function fmtK(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1)}K`;
}
