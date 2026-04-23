import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pickTemplate, scaffoldFlow } from '../src/scaffold.js';

describe('scaffoldFlow', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'relay-gen-'));
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  describe('blank template', () => {
    it('[GEN-001] emits flow.ts instead of race.ts', async () => {
      const outDir = join(tmp, 'my-flow');
      const result = await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'my-flow' },
      });

      expect(result.isOk()).toBe(true);
      const files = await readdir(outDir);
      expect(files).toContain('flow.ts');
      expect(files).not.toContain('race.ts');
    });

    it('[GEN-002] flow.ts uses defineFlow and step.prompt with handoff', async () => {
      const outDir = join(tmp, 'my-flow');
      await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'my-flow' },
      });

      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain('defineFlow');
      expect(content).toContain('step.prompt');
      expect(content).toContain('handoff');
      expect(content).not.toContain('defineRace');
      expect(content).not.toContain('runner.');
      expect(content).not.toContain('baton');
    });

    it('[GEN-003] package.json main points to dist/flow.js', async () => {
      const outDir = join(tmp, 'my-flow');
      await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'my-flow' },
      });

      const raw = await readFile(join(outDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      expect(pkg['main']).toBe('./dist/flow.js');
    });

    it('[GEN-017] package.json relay block contains flowName', async () => {
      const outDir = join(tmp, 'my-flow');
      await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'my-flow' },
      });

      const raw = await readFile(join(outDir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as Record<string, unknown>;
      const relay = pkg['relay'] as Record<string, unknown> | undefined;
      expect(relay).toBeDefined();
      expect(relay?.['flowName']).toBe('my-flow');
    });

    it('[GEN-004] token substitution replaces pkgName in flow.ts', async () => {
      const outDir = join(tmp, 'my-flow');
      await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'my-flow' },
      });

      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain("name: 'my-flow'");
      expect(content).not.toContain('{{pkgName}}');
    });
  });

  describe('linear template', () => {
    const tokens = {
      pkgName: 'my-linear',
      'stepNames[0]': 'gather',
      'stepNames[1]': 'analyze',
      'stepNames[2]': 'report',
    };

    it('[GEN-005] linear template emits flow.ts with step.prompt and handoff', async () => {
      const outDir = join(tmp, 'my-linear');
      const result = await scaffoldFlow({ template: 'linear', outDir, tokens });

      expect(result.isOk()).toBe(true);
      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain('defineFlow');
      expect(content).toContain('step.prompt');
      expect(content).toContain("handoff: 'gather'");
      expect(content).not.toContain('baton');
      expect(content).not.toContain('runners:');
    });

    it('[GEN-006] linear template substitutes all stepNames tokens', async () => {
      const outDir = join(tmp, 'my-linear');
      await scaffoldFlow({ template: 'linear', outDir, tokens });

      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain("'gather'");
      expect(content).toContain("'analyze'");
      expect(content).toContain("'report'");
      expect(content).not.toContain('{{stepNames[0]}}');
    });
  });

  describe('fan-out template', () => {
    it('[GEN-007] fan-out template uses step.parallel and handoff', async () => {
      const outDir = join(tmp, 'my-fan-out');
      const result = await scaffoldFlow({
        template: 'fan-out',
        outDir,
        tokens: { pkgName: 'my-fan-out' },
      });

      expect(result.isOk()).toBe(true);
      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain('step.parallel');
      expect(content).toContain('step.prompt');
      expect(content).toContain('handoff');
      expect(content).not.toContain('runner.');
      expect(content).not.toContain('baton');
    });
  });

  describe('discovery template', () => {
    it('[GEN-008] discovery template uses step.prompt and handoff', async () => {
      const outDir = join(tmp, 'my-discovery');
      const result = await scaffoldFlow({
        template: 'discovery',
        outDir,
        tokens: { pkgName: 'my-discovery' },
      });

      expect(result.isOk()).toBe(true);
      const content = await readFile(join(outDir, 'flow.ts'), 'utf8');
      expect(content).toContain('defineFlow');
      expect(content).toContain('step.prompt');
      expect(content).toContain('handoff');
      expect(content).not.toContain('runner.');
      expect(content).not.toContain('baton');
      expect(content).not.toContain('defineRace');
    });
  });

  describe('error cases', () => {
    it('[GEN-009] returns template-not-found for unknown template', async () => {
      const outDir = join(tmp, 'out');
      const result = await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'x' },
      });
      expect(result.isOk()).toBe(true);

      const badResult = await scaffoldFlow({
        template: 'unknown' as 'blank',
        outDir: join(tmp, 'bad'),
        tokens: {},
      });
      expect(badResult.isErr()).toBe(true);
      if (badResult.isErr()) {
        expect(badResult.error.kind).toBe('template-not-found');
      }
    });

    it('[GEN-010] returns file-exists when output file already exists without force', async () => {
      const outDir = join(tmp, 'dup');
      await mkdir(outDir, { recursive: true });

      const first = await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'dup' },
      });
      expect(first.isOk()).toBe(true);

      const second = await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'dup' },
        force: false,
      });
      expect(second.isErr()).toBe(true);
      if (second.isErr()) {
        expect(second.error.kind).toBe('file-exists');
      }
    });

    it('[GEN-011] force flag overwrites existing files', async () => {
      const outDir = join(tmp, 'forced');
      await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'forced' },
      });
      const result = await scaffoldFlow({
        template: 'blank',
        outDir,
        tokens: { pkgName: 'forced' },
        force: true,
      });
      expect(result.isOk()).toBe(true);
    });

    it('[GEN-012] returns missing-token when a non-prompt file has an unresolved token', async () => {
      const outDir = join(tmp, 'missing-token');
      const result = await scaffoldFlow({
        template: 'linear',
        outDir,
        tokens: { pkgName: 'my-linear' },
        // stepNames tokens intentionally omitted
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe('missing-token');
      }
    });
  });
});

describe('pickTemplate', () => {
  it('[GEN-013] returns discovery for codebase-related intent', () => {
    expect(pickTemplate('explore the codebase')).toBe('discovery');
    expect(pickTemplate('audit the repo')).toBe('discovery');
    expect(pickTemplate('document the project')).toBe('discovery');
    expect(pickTemplate('review codebase for issues')).toBe('discovery');
  });

  it('[GEN-014] returns linear for sequential intent', () => {
    expect(pickTemplate('first gather then analyze')).toBe('linear');
    expect(pickTemplate('a chain of three steps')).toBe('linear');
    expect(pickTemplate('run them sequential')).toBe('linear');
  });

  it('[GEN-015] returns fan-out for parallel intent', () => {
    expect(pickTemplate('fan out into two branches')).toBe('fan-out');
    expect(pickTemplate('run in parallel')).toBe('fan-out');
  });

  it('[GEN-016] returns blank for unrecognized intent', () => {
    expect(pickTemplate('some random description')).toBe('blank');
    expect(pickTemplate('')).toBe('blank');
  });
});
