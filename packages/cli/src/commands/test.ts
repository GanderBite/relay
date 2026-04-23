/**
 * relay test — smoke-test a flow against fixture files.
 *
 * v1 scope (tech spec §10.3):
 *   1. Resolve the flow via loadFlow.
 *   2. Look for test/fixtures/*.json in the flow package directory.
 *   3. If no fixtures directory exists, print a friendly message and exit 0
 *      (tests are optional in v1).
 *   4. For each fixture file:
 *      - Parse and validate { input, expectedArtifacts? } via Zod.
 *      - Run the flow with MockProvider registered under every provider name
 *        the flow references (default: 'claude' + 'mock').
 *      - Check that every path listed in expectedArtifacts exists after the run.
 *      - Print pass / fail per fixture.
 *   5. Exit 0 if all fixtures pass, exit 1 if any fail.
 *
 * Full eval harness lands in v1.x — see relay.dev/docs/testing.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Flow,
  InvocationContext,
  InvocationRequest,
  InvocationResponse,
  Provider,
  ProviderCapabilities,
} from '@relay/core';
import { Orchestrator, ProviderRegistry, z } from '@relay/core';
import { MockProvider } from '@relay/core/testing';
import { MARK, SYMBOLS } from '../brand.js';
import { gray, green, red } from '../color.js';
import { EXIT_CODES, formatError } from '../exit-codes.js';
import type { LoadedFlow } from '../flow-loader.js';
import { loadFlow } from '../flow-loader.js';
import { STEP_NAME_WIDTH } from '../layout.js';

// ---------------------------------------------------------------------------
// Fixture schema (Zod v4)
// ---------------------------------------------------------------------------

const FixtureSchema = z.object({
  input: z.record(z.string(), z.unknown()),
  expectedArtifacts: z.array(z.string()).optional(),
});

type Fixture = z.infer<typeof FixtureSchema>;

// ---------------------------------------------------------------------------
// Default mock response
// ---------------------------------------------------------------------------

const defaultResponse: InvocationResponse = {
  text: '{}',
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  },
  stopReason: 'end_turn',
  numTurns: 1,
  durationMs: 0,
  model: 'mock-model',
};

// ---------------------------------------------------------------------------
// NamedMockProvider — MockProvider with a configurable name
//
// MockProvider.name is always 'mock'. ProviderRegistry keys by provider.name,
// so flows whose steps reference a different provider (e.g. 'claude') would
// fail with "provider not registered". This thin wrapper lets us register
// the same catch-all behaviour under any provider name the flow references.
// ---------------------------------------------------------------------------

class NamedMockProvider implements Provider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  private readonly inner: MockProvider;

  constructor(name: string) {
    this.name = name;
    this.inner = new MockProvider({
      responses: new Proxy({} as Record<string, InvocationResponse>, {
        get: () => defaultResponse,
        has: () => true,
      }),
    });
    this.capabilities = this.inner.capabilities;
  }

  authenticate(): ReturnType<MockProvider['authenticate']> {
    return this.inner.authenticate();
  }

  invoke(req: InvocationRequest, ctx: InvocationContext): ReturnType<MockProvider['invoke']> {
    return this.inner.invoke(req, ctx);
  }

  stream(
    req: InvocationRequest,
    ctx: InvocationContext,
  ): ReturnType<NonNullable<MockProvider['stream']>> {
    return this.inner.stream(req, ctx);
  }
}

// ---------------------------------------------------------------------------
// Build a ProviderRegistry covering all providers the flow references
// ---------------------------------------------------------------------------

function buildRegistry(_flow: Flow<unknown>): ProviderRegistry {
  const registry = new ProviderRegistry();
  const mock = new NamedMockProvider('mock');
  const regResult = registry.register(mock);
  if (regResult.isErr()) throw regResult.error;
  return registry;
}

// ---------------------------------------------------------------------------
// Per-fixture result
// ---------------------------------------------------------------------------

interface FixtureResult {
  name: string;
  passed: boolean;
  reason?: string;
}

async function runFixture(fixturePath: string, loadedFlow: LoadedFlow): Promise<FixtureResult> {
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

  // Validate fixture shape via Zod
  const parseResult = FixtureSchema.safeParse(raw);
  if (!parseResult.success) {
    const msg = parseResult.error.issues[0]?.message ?? 'schema error';
    return {
      name: fixtureName,
      passed: false,
      reason: `fixture invalid: ${msg}`,
    };
  }

  const fixture: Fixture = parseResult.data;
  const flow = loadedFlow.flow;
  const registry = buildRegistry(flow);

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
    const orchestrator = new Orchestrator({
      providers: registry,
      runDir: tempDir,
    });
    runResult = await orchestrator.run(flow, fixture.input, {
      flowDir: loadedFlow.dir,
      authTimeoutMs: 5000,
      flagProvider: 'mock',
    });
  } catch (runErr) {
    const msg = runErr instanceof Error ? runErr.message : String(runErr);
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
  const namePadded = result.name.padEnd(STEP_NAME_WIDTH);
  if (result.passed) {
    process.stdout.write(` ${green(SYMBOLS.ok)} ${namePadded}\n`);
  } else {
    process.stdout.write(` ${red(SYMBOLS.fail)} ${namePadded}\n`);
    if (result.reason !== undefined) {
      process.stdout.write(`     ${result.reason}\n`);
    }
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
 * @param _opts  Parsed option flags (unused in v1)
 */
export default async function testCommand(args: unknown[], _opts: unknown): Promise<void> {
  const flowPath = typeof args[0] === 'string' ? args[0] : '';

  if (flowPath === '') {
    process.stderr.write('usage: relay test <flow>\n');
    process.exit(EXIT_CODES.definition_error);
  }

  // ---------------------------------------------------------------------------
  // Step 1 — load the flow package
  // ---------------------------------------------------------------------------
  const loadResult = await loadFlow(flowPath, process.cwd());
  if (loadResult.isErr()) {
    process.stderr.write(formatError(loadResult.error) + '\n');
    process.exit(EXIT_CODES.definition_error);
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
    process.exit(EXIT_CODES.success);
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
    process.exit(EXIT_CODES.definition_error);
  }

  if (entries.length === 0) {
    printNoFixtures();
    process.exit(EXIT_CODES.success);
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

  process.exit(passCount === total ? EXIT_CODES.success : EXIT_CODES.runner_failure);
}
