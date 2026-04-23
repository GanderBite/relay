#!/usr/bin/env node
/**
 * generate-registry — CLI wrapper for generateRegistryJson().
 *
 * Usage:
 *   node bin/generate-registry.js --input packages.json --output catalog/registry.json
 *   node bin/generate-registry.js @relay/flows-codebase-discovery ./my-local-flow
 *
 * --input <file>    JSON file containing an array of package names / local paths.
 *                   Merged with any positional arguments.
 * --output <file>   Destination for the generated registry.json.
 *                   Default: catalog/registry.json (relative to cwd).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

async function main() {
  const argv = process.argv.slice(2);

  // ---------------------------------------------------------------------------
  // Parse flags
  // ---------------------------------------------------------------------------
  let inputFile = null;
  let outputFile = 'catalog/registry.json';
  const positional = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--input' || arg === '-i') {
      inputFile = argv[++i] ?? null;
    } else if (arg === '--output' || arg === '-o') {
      outputFile = argv[++i] ?? outputFile;
    } else if (arg !== undefined && !arg.startsWith('--')) {
      positional.push(arg);
    }
  }

  // ---------------------------------------------------------------------------
  // Gather package list
  // ---------------------------------------------------------------------------
  const packages = [...positional];

  if (inputFile !== null) {
    const absInput = resolve(process.cwd(), inputFile);
    let raw;
    try {
      raw = await readFile(absInput, 'utf8');
    } catch (readErr) {
      process.stderr.write(
        `generate-registry: cannot read input file "${absInput}": ${readErr?.message ?? readErr}\n`,
      );
      process.exit(1);
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      process.stderr.write(
        `generate-registry: input file is not valid JSON: ${parseErr?.message ?? parseErr}\n`,
      );
      process.exit(1);
    }

    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      process.stderr.write('generate-registry: input file must be a JSON array of strings\n');
      process.exit(1);
    }

    packages.push(...parsed);
  }

  if (packages.length === 0) {
    process.stderr.write(
      'generate-registry: no packages specified\n' +
        'Usage: generate-registry [--input packages.json] [--output out.json] [pkg...]\n',
    );
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Run the generator (imported from the compiled dist)
  // ---------------------------------------------------------------------------
  let generateRegistryJson;
  try {
    const mod = await import('../dist/cli.js');
    generateRegistryJson = mod.generateRegistryJson;
    if (typeof generateRegistryJson !== 'function') {
      throw new Error('"generateRegistryJson" not found in dist/cli.js exports');
    }
  } catch (importErr) {
    process.stderr.write(
      `generate-registry: failed to load registry module: ${importErr?.message ?? importErr}\n` +
        'Make sure you have run "pnpm -F @relay/cli build" first.\n',
    );
    process.exit(1);
  }

  const result = await generateRegistryJson(packages);

  if (result.isErr()) {
    process.stderr.write(`generate-registry: ${result.error.message}\n`);
    process.exit(1);
  }

  const doc = result.value;

  // ---------------------------------------------------------------------------
  // Write output
  // ---------------------------------------------------------------------------
  const absOutput = resolve(process.cwd(), outputFile);

  try {
    await mkdir(dirname(absOutput), { recursive: true });
    await writeFile(absOutput, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (writeErr) {
    process.stderr.write(
      `generate-registry: failed to write "${absOutput}": ${writeErr?.message ?? writeErr}\n`,
    );
    process.exit(1);
  }

  const count = doc.flows.length;
  process.stdout.write(
    `generate-registry: wrote ${count} flow${count !== 1 ? 's' : ''} to ${absOutput}\n`,
  );
}

main().catch((err) => {
  process.stderr.write((err?.stack ?? err) + '\n');
  process.exit(1);
});
