import { execFileSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  type ScaffoldReport,
  scaffoldFlow,
  type TemplateId,
} from '@ganderbite/relay-generator/scaffold';
import { MARK, SYMBOLS } from '../brand.js';
import { green, red } from '../color.js';
import { EXIT_CODES } from '../exit-codes.js';

export interface NewCommandOptions {
  template?: string;
  force?: boolean;
}

const VALID_TEMPLATES: ReadonlySet<string> = new Set(['blank', 'linear', 'fan-out', 'discovery']);

function isTemplateId(s: string): s is TemplateId {
  return VALID_TEMPLATES.has(s);
}

async function skillIsInstalled(): Promise<boolean> {
  const skillDir = path.join(os.homedir(), '.claude', 'skills', 'relay-generator');
  try {
    await stat(skillDir);
    return true;
  } catch {
    return false;
  }
}

function printModeA(): void {
  process.stdout.write(
    `${MARK}  relay new\n` +
      '\n' +
      'the relay generator skill is installed in claude code.\n' +
      '\n' +
      'open a new claude code session in this directory and say:\n' +
      '\n' +
      '    scaffold a new relay flow\n' +
      '\n' +
      'or, to skip the skill and start from a blank template:\n' +
      '\n' +
      '    relay new my-flow --template blank\n',
  );
}

function printInvalidName(name: string): void {
  process.stderr.write(
    `${red(`${SYMBOLS.fail} invalid flow name: "${name}"`)}\n` +
      '\n' +
      '  flow names must be lowercase kebab-case (e.g. my-flow, codebase-discovery).\n' +
      '\n' +
      '  \u2192 relay new my-flow\n',
  );
}

function printModeB(
  name: string,
  template: TemplateId,
  report: ScaffoldReport,
  installed: boolean,
): void {
  const lines: string[] = [];

  lines.push(`${MARK}  relay new ${name} (${template} template)`);
  lines.push('');

  for (const absPath of report.filesWritten) {
    const rel = './' + path.relative(process.cwd(), absPath);
    lines.push(` ${green(SYMBOLS.ok)} wrote ${rel}`);
  }

  if (installed) {
    lines.push(` ${green(SYMBOLS.ok)} installed dev dependencies`);
  } else {
    lines.push(` ${red(SYMBOLS.fail)} could not install dev dependencies`);
    lines.push('');
    lines.push(`  run: cd ${name} && npm install`);
  }

  lines.push('');
  lines.push('try it:');
  lines.push(`    cd ${name} && relay run .`);
  lines.push('');

  process.stdout.write(lines.join('\n'));
}

export default async function newCommand(args: unknown[], opts: unknown): Promise<void> {
  const options = (opts ?? {}) as NewCommandOptions;
  const name = typeof args[0] === 'string' ? args[0] : '';

  // Validate name: must be non-empty and kebab-case.
  if (name === '' || !/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(name)) {
    printInvalidName(name);
    process.exit(EXIT_CODES.definition_error);
  }

  // Mode A: skill is installed and user did not pass --template.
  if (options.template === undefined) {
    const installed = await skillIsInstalled();
    if (installed) {
      printModeA();
      process.exit(EXIT_CODES.success);
    }
  }

  // Mode B: skill not installed, or --template was passed.
  const templateRaw = options.template ?? 'blank';
  if (!isTemplateId(templateRaw)) {
    process.stderr.write(
      `${red(`${SYMBOLS.fail} unknown template: "${templateRaw}"`)}\n` +
        '\n' +
        '  valid templates: blank, linear, fan-out, discovery.\n' +
        '\n' +
        `  \u2192 relay new ${name} --template blank\n`,
    );
    process.exit(EXIT_CODES.definition_error);
  }

  const template: TemplateId = templateRaw;
  const outDir = path.resolve(process.cwd(), name);

  const result = await scaffoldFlow({
    template,
    outDir,
    tokens: { name, 'flow-name': name, pkgName: name },
    force: options.force ?? false,
  });

  if (result.isErr()) {
    const e = result.error;
    if (e.kind === 'file-exists') {
      process.stderr.write(
        `${red(`${SYMBOLS.fail} directory already exists: ${e.path}`)}\n` +
          '\n' +
          '  pass --force to overwrite.\n' +
          '\n' +
          `  \u2192 relay new ${name} --force\n`,
      );
      process.exit(EXIT_CODES.runner_failure);
    } else if (e.kind === 'template-not-found') {
      process.stderr.write(
        `${red(`${SYMBOLS.fail} template not found: "${e.template}"`)}\n` +
          '\n' +
          `  \u2192 relay new ${name} --template blank\n`,
      );
      process.exit(EXIT_CODES.definition_error);
    } else if (e.kind === 'missing-token') {
      process.stderr.write(`${red(`${SYMBOLS.fail} missing token ${e.token} in ${e.path}`)}\n`);
      process.exit(EXIT_CODES.definition_error);
    } else {
      // e.kind === 'io-error'
      const msg = e.cause instanceof Error ? e.cause.message : String(e.cause);
      process.stderr.write(`${red(`${SYMBOLS.fail} scaffold failed: ${msg}`)}\n`);
      process.exit(EXIT_CODES.runner_failure);
    }
  }

  let installed = false;
  try {
    execFileSync('npm', ['install'], { cwd: outDir, stdio: 'ignore', timeout: 120_000 });
    installed = true;
  } catch {
    installed = false;
  }

  printModeB(name, template, result.value, installed);
  process.exit(EXIT_CODES.success);
}
