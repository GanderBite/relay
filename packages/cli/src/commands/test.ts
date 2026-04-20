/**
 * relay test — smoke-test a flow against fixture files.
 *
 * v1 scope (§10.3):
 *   1. Resolve the flow via loadFlow.
 *   2. Look for test/fixtures/*.json in the flow package directory.
 *   3. If no fixtures directory exists, print a friendly message and exit 0
 *      (tests are optional in v1).
 *   4. For each fixture file:
 *      - Parse { input, expectedArtifacts? }.
 *      - Run the flow with a catch-all MockProvider.
 *      - Check that every path listed in expectedArtifacts exists after the run.
 *      - Print PASS / FAIL per fixture.
 *   5. Exit 0 if all fixtures pass, exit 1 if any fail.
 *
 * Full eval harness lands in v1.x — see relay.dev/docs/testing.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { MockProvider } from '@relay/core/testing';
import { Runner, ProviderRegistry } from '@relay/core';

import { formatError } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import type { LoadedFlow } from '../flow-loader.js';
import { MARK, SYMBOLS, green, red, gray } from '../visual.js';

// ---------------------------------------------------------------------------
// Fixture shape
// ---------------------------------------------------------------------------

interface Fixture {
  input: Record<string, unknown>;
  expectedArtifacts?: string[];
}

function isFixture(value: unknown): value is Fixture {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj['input'] !== 'object' || obj['input'] === null) return false;
  if (obj['expectedArtifacts'] !== undefined && !Array.isArray(obj['expectedArtifacts'])) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Catch-all MockProvider factory
// ---------------------------------------------------------------------------

const defaultResponse = {
  text: '',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  stopReason: 'end_turn' as const,
  numTurns: 1,
  durationMs: 0,
  model: 'mock-model',
};

function buildCatchAllProvider(): MockProvider {
  const responses = new Proxy({} as Record<string, typeof defaultResponse>, {
    get: (_target, _key) => defaultResponse,
    has: (_target, _key) => true,
  });
  return new MockProvider({ responses });
}

// ---------------------------------------------------------------------------
// Per-fixture result
// ---------------------------------------------------------------------------

interface FixtureResult {
  name: string;
  passed: boolean;
  reason?: string;
}

async function runFixture(
  fixturePath: string,
  loadedFlow: LoadedFlow,
): Promise<FixtureResult> {
  const fixtureName = path.basename(fixturePath, '.json');

  // Parse fixture JSON
  let raw: unknown;
  try {
    const content = await fs.readFile(fixturePath, 'utf8');
    raw = JSON.parse(content) as unknown;
  } catch (parseErr) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return { name: fixtureName, passed: false, reason: `could not parse fixture: ${msg}` };
  }

  if (!isFixture(raw)) {
    return {
      name: fixtureName,
      passed: false,
      reason: 'fixture must have shape { "input": {}, "expectedArtifacts": [] }',
    };
  }

  const fixture = raw;
  const mockProvider = buildCatchAllProvider();
  const registry = new ProviderRegistry();
  registry.register(mockProvider);

  // Create a temp run directory
  const tempDir = path.join(os.tmpdir(), `relay-test-${randomBytes(4).toString('hex')}`);
  try {
    await fs.mkdir(tempDir, { recursive: true });
  } catch (mkdirErr) {
    const msg = mkdirErr instanceof Error ? mkdirErr.message : String(mkdirErr);
    return { name: fixtureName, passed: false, reason: `could not create temp dir: ${msg}` };
  }

  let runResult: { status: string };
  try {
    const runner = new Runner({
      providers: registry,
      defaultProvider: 'mock',
      runDir: tempDir,
    });
    runResult = await runner.run(loadedFlow.flow, fixture.input, {
      flowDir: loadedFlow.dir,
      authTimeoutMs: 5000,
    });
  } catch (runErr) {
    const msg = runErr instanceof Error ? runErr.message : String(runErr);
    // Best-effort cleanup
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return { name: fixtureName, passed: false, reason: `run failed: ${msg}` };
  }

  if (runResult.status !== 'succeeded') {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    return {
      name: fixtureName,
      passed: false,
      reason: `run ended with status: ${runResult.status}`,
    };
  }

  // Check expected artifacts
  const expectedArtifacts = fixture.expectedArtifacts ?? [];
  for (const artifact of expectedArtifacts) {
    const artifactPath = path.join(loadedFlow.dir, artifact);
    try {
      await fs.stat(artifactPath);
    } catch {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      return { name: fixtureName, passed: false, reason: `missing artifact: ${artifact}` };
    }
  }

  // Best-effort cleanup
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  return { name: fixtureName, passed: true };
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function printHeader(): void {
  process.stdout.write(`${MARK}  relay test\n\n`);
}

function printNoFixtures(): void {
  printHeader();
  process.stdout.write('no test fixtures found in test/fixtures/.\n\n');
  process.stdout.write('add a fixture file to run smoke tests:\n');
  process.stdout.write(
    '    test/fixtures/basic.json  \u2192  { "input": {}, "expectedArtifacts": [] }\n',
  );
  process.stdout.write('\n');
  process.stdout.write('full eval harness lands in v1.x \u2014 see relay.dev/docs/testing\n');
}

function printFixtureResult(result: FixtureResult): void {
  if (result.passed) {
    process.stdout.write(` ${green(SYMBOLS.ok)} ${result.name}\n`);
  } else {
    const reason = result.reason !== undefined ? `  ${result.reason}` : '';
    process.stdout.write(` ${red(SYMBOLS.fail)} ${result.name}${reason}\n`);
  }
}

function printSummary(passCount: number, total: number): void {
  const failCount = total - passCount;
  if (failCount === 0) {
    process.stdout.write(`\n  ${gray(`${passCount}/${total} fixtures passed`)}\n`);
  } else {
    process.stdout.write(
      `\n  ${gray(`${passCount}/${total} fixtures passed`)}  ${red(`${failCount} failed`)}\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public command interface
// ---------------------------------------------------------------------------

/**
 * Entry point dispatched by the CLI for `relay test <flow>`.
 *
 * @param args  Argv slice after "test": [flowNameOrPath]
 * @param opts  Parsed option flags (unused in v1)
 */
export default async function testCommand(args: unknown[], _opts: unknown): Promise<void> {
  const flowPath = typeof args[0] === 'string' ? args[0] : '';

  if (flowPath === '') {
    process.stderr.write('usage: relay test <flow>\n');
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Step 1 — load the flow package
  // ---------------------------------------------------------------------------
  const loadResult = await loadFlow(flowPath, process.cwd());
  if (loadResult.isErr()) {
    process.stderr.write(formatError(loadResult.error) + '\n');
    process.exit(1);
  }
  const loadedFlow = loadResult.value;

  // ---------------------------------------------------------------------------
  // Step 2 — locate fixtures directory
  // ---------------------------------------------------------------------------
  const fixturesDir = path.join(loadedFlow.dir, 'test', 'fixtures');

  let fixturesExist = false;
  try {
    const stat = await fs.stat(fixturesDir);
    fixturesExist = stat.isDirectory();
  } catch {
    fixturesExist = false;
  }

  if (!fixturesExist) {
    printNoFixtures();
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Step 3 — read fixture files
  // ---------------------------------------------------------------------------
  let entries: string[];
  try {
    const dirEntries = await fs.readdir(fixturesDir);
    entries = dirEntries.filter((e) => e.endsWith('.json'));
  } catch (readdirErr) {
    const msg = readdirErr instanceof Error ? readdirErr.message : String(readdirErr);
    process.stderr.write(`could not read fixtures directory: ${msg}\n`);
    process.exit(1);
  }

  if (entries.length === 0) {
    printNoFixtures();
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Step 4 — run each fixture
  // ---------------------------------------------------------------------------
  printHeader();

  const results: FixtureResult[] = [];
  for (const entry of entries) {
    const fixturePath = path.join(fixturesDir, entry);
    const result = await runFixture(fixturePath, loadedFlow);
    results.push(result);
    printFixtureResult(result);
  }

  // ---------------------------------------------------------------------------
  // Step 5 — summary and exit
  // ---------------------------------------------------------------------------
  const passCount = results.filter((r) => r.passed).length;
  const total = results.length;
  printSummary(passCount, total);

  process.exit(passCount === total ? 0 : 1);
}
