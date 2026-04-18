import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLogger, type Logger } from '../src/logger.js';

const ROOT = mkdtempSync(join(tmpdir(), 'relay-log-root-'));

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

let counter = 0;

async function capture(
  fn: (logger: Logger) => void,
  opts?: { flowName?: string; runId?: string },
): Promise<Record<string, unknown>[]> {
  counter += 1;
  const logFile = join(ROOT, `run-${counter}.log`);
  const logger = createLogger({
    flowName: opts?.flowName ?? 'test-flow',
    runId: opts?.runId ?? 'r1',
    logFile,
    level: 'debug',
  });
  fn(logger);
  // Wait for the async pino destination to flush. pino's flush on multistream
  // accepts a callback; fall back to a long-enough sleep if flush is absent.
  await new Promise<void>((resolve) => {
    const maybeFlush = (logger as unknown as { flush?: (cb: () => void) => void }).flush;
    if (typeof maybeFlush === 'function') {
      maybeFlush.call(logger, () => setTimeout(resolve, 50));
    } else {
      setTimeout(resolve, 200);
    }
  });
  if (!existsSync(logFile)) {
    // Give pino a final chance to open and flush.
    await new Promise((res) => setTimeout(res, 200));
  }
  const raw = existsSync(logFile) ? readFileSync(logFile, 'utf8') : '';
  return raw
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('createLogger — redaction and binding', () => {
  it('[LOG-001] redacts ANTHROPIC_API_KEY when present in a nested payload', async () => {
    const lines = await capture((logger) => {
      logger.info({ creds: { ANTHROPIC_API_KEY: 'sk-ant-xxx' }, ok: true }, 'nested');
    });
    expect(lines.length).toBeGreaterThan(0);
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain('sk-ant-xxx');
    expect(lines[0]).toMatchObject({ ok: true });
  });

  describe('[LOG-002] redacts authorization + *_TOKEN + *_SECRET + *_PASSWORD + cookie', () => {
    it('authorization', async () => {
      const lines = await capture((logger) => {
        logger.info({ data: { authorization: 'Bearer abc123', regular: 'visible' } }, 't');
      });
      const raw = JSON.stringify(lines[0]);
      expect(raw).not.toContain('abc123');
      expect(raw).toContain('visible');
    });
    it('*_TOKEN', async () => {
      const lines = await capture((logger) => {
        logger.info({ data: { SLACK_TOKEN: 'xoxb-xxx' } }, 't');
      });
      expect(JSON.stringify(lines[0])).not.toContain('xoxb-xxx');
    });
    it('*_SECRET', async () => {
      const lines = await capture((logger) => {
        logger.info({ data: { MY_SECRET: 'shh' } }, 't');
      });
      expect(JSON.stringify(lines[0])).not.toContain('"shh"');
    });
    it('*_PASSWORD', async () => {
      const lines = await capture((logger) => {
        logger.info({ data: { DB_PASSWORD: 'pass123' } }, 't');
      });
      expect(JSON.stringify(lines[0])).not.toContain('pass123');
    });
    it('cookie', async () => {
      const lines = await capture((logger) => {
        logger.info({ data: { cookie: 'session=xyz' } }, 't');
      });
      expect(JSON.stringify(lines[0])).not.toContain('session=xyz');
    });
  });

  it('[LOG-003] every emitted line auto-carries flowName and runId', async () => {
    const lines = await capture(
      (logger) => {
        logger.info({ event: 'step.start', stepId: 'inventory' }, 't');
      },
      { flowName: 'codebase-discovery', runId: 'f9c3a2' },
    );
    expect(lines.length).toBeGreaterThan(0);
    expect(lines[0]).toMatchObject({
      flowName: 'codebase-discovery',
      runId: 'f9c3a2',
      stepId: 'inventory',
      event: 'step.start',
    });
  });
});
