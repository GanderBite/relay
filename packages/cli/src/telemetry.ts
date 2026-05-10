/**
 * Opt-in telemetry for relay run.
 *
 * Reads the telemetry key from ~/.relay/settings.json at call time. When
 * telemetry.enabled is true, POSTs one anonymized event per run to the
 * telemetry endpoint. All failures are swallowed silently — telemetry must
 * never affect the run's exit code.
 *
 * No flow input data, no prompt content, no path strings are sent. The only
 * fields that tie a run to the catalog are flowName and flowVersion.
 */

import { loadGlobalSettings } from '@ganderbite/relay-core';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TELEMETRY_ENDPOINT = 'https://telemetry.relay.dev/runs';
const TELEMETRY_TIMEOUT_MS = 2_000;

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

/**
 * Returns true only when ~/.relay/settings.json exists, is valid, and has
 * telemetry.enabled set to true. Any read, parse, or validation failure
 * returns false — telemetry is disabled by default.
 */
export async function isEnabled(): Promise<boolean> {
  const result = await loadGlobalSettings();
  if (result.isErr()) return false;
  return result.value?.telemetry?.enabled === true;
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
  if (!(await isEnabled())) return;

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
