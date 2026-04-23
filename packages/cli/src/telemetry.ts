/**
 * Opt-in telemetry for relay run.
 *
 * Reads ~/.relay/config.json at call time. When telemetry.enabled is true,
 * POSTs one anonymized event per run to the telemetry endpoint. All failures
 * are swallowed silently — telemetry must never affect the run's exit code.
 *
 * No flow input data, no prompt content, no path strings are sent. The only
 * fields that tie a run to the catalog are flowName and flowVersion.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_ENDPOINT = 'https://telemetry.relay.dev/runs';
const TELEMETRY_TIMEOUT_MS = 2_000;
const CONFIG_PATH = join(homedir(), '.relay', 'config.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Anonymized event sent once per completed run when telemetry is enabled.
 * No input data, no prompts, no file paths.
 */
export interface RunEvent {
  flowName: string;
  flowVersion: string;
  status: 'success' | 'failure' | 'aborted';
  durationMs: number;
  stepsCount: number;
  totalCostUsd: number;
  relayVersion: string;
  nodeVersion: string;
  platform: string;
}

// ---------------------------------------------------------------------------
// Config reading
// ---------------------------------------------------------------------------

interface RelayConfig {
  telemetry?: {
    enabled?: boolean;
  };
}

/**
 * Returns true only when ~/.relay/config.json exists, is valid JSON, and
 * has telemetry.enabled set to true. Any read or parse failure returns false.
 * Synchronous so callers can guard cheaply without async overhead.
 */
export function isEnabled(): boolean {
  try {
    const raw = readFileSync(CONFIG_PATH, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const config = parsed as RelayConfig;
      return config.telemetry?.enabled === true;
    }
    return false;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event sender
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget telemetry POST. Resolves (never rejects) regardless of
 * whether telemetry is enabled, the network is available, or the endpoint
 * returns an error. Uses a 2-second AbortController timeout.
 */
export async function maybeSendRunEvent(evt: RunEvent): Promise<void> {
  if (!isEnabled()) return;

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, TELEMETRY_TIMEOUT_MS);
  try {
    await fetch(TELEMETRY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(evt),
      signal: controller.signal,
    });
  } catch {
    // Swallow all errors — network failure, timeout, non-2xx responses, etc.
    // Telemetry must never influence the run's outcome or exit code.
  } finally {
    clearTimeout(timer);
  }
}
