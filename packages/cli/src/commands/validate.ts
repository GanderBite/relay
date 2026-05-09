/**
 * relay validate — load a flow and validate its step graph.
 *
 * No orchestrator is started; no provider is contacted; no Claude calls are made.
 *
 * Exit codes:
 *   0 — flow loaded and validated
 *   1 — load error (FlowLoadError or unexpected runtime error)
 *   2 — flow definition error (FlowDefinitionError)
 */

import { FlowDefinitionError } from '@ganderbite/relay-core';
import { SYMBOLS } from '../brand.js';
import { green, red } from '../color.js';
import { EXIT_CODES } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';

/**
 * Entry point dispatched by the CLI for `relay validate <flow>`.
 *
 * @param args  Argv slice: [flowNameOrPath]
 */
export default async function validateCommand(args: unknown[], _opts: unknown): Promise<void> {
  const nameOrPath = typeof args[0] === 'string' ? args[0] : '';

  if (nameOrPath === '') {
    process.stderr.write(red(`${SYMBOLS.fail}  usage: relay validate <flow>`) + '\n');
    process.exit(EXIT_CODES.runner_failure);
  }

  const loadResult = await loadFlow(nameOrPath, process.cwd());

  if (loadResult.isErr()) {
    const loadErr = loadResult.error;
    const code =
      loadErr instanceof FlowDefinitionError
        ? EXIT_CODES.definition_error
        : EXIT_CODES.runner_failure;
    process.stderr.write(red(`${SYMBOLS.fail}  ${loadErr.message}`) + '\n');
    process.exit(code);
  }

  const { flow } = loadResult.value;

  process.stdout.write(green(`${SYMBOLS.ok} ${flow.name} v${flow.version}  valid`) + '\n');
  process.exit(EXIT_CODES.success);
}
