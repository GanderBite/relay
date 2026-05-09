/**
 * relay dry-run — validate a flow and preview what each step will do.
 *
 * Loads and validates the flow, parses optional input from argv, then walks
 * the planned step order and prints the env each script/branch step will see
 * plus the prompt file path for prompt steps.
 *
 * No orchestrator is started; no provider is contacted; no Claude calls are made.
 *
 * Exit codes:
 *   0 — flow loaded, validated, and plan printed
 *   1 — load error (FlowLoadError or unexpected runtime error)
 *   2 — flow definition error (FlowDefinitionError) or input parse error
 */

import { access } from 'node:fs/promises';
import type { BranchStep, Flow, PromptStep, ScriptStep, Step } from '@ganderbite/relay-core';
import { FlowDefinitionError } from '@ganderbite/relay-core';
import { MARK, SYMBOLS } from '../brand.js';
import { dim, green, red, yellow } from '../color.js';
import { EXIT_CODES } from '../exit-codes.js';
import { loadFlow } from '../flow-loader.js';
import { parseInputFromArgv } from '../input-parser.js';

// ---------------------------------------------------------------------------
// Secret redaction
//
// Key names that match any of these substrings (case-insensitive) have their
// values replaced with "[redacted]" in the printed plan.
// ---------------------------------------------------------------------------

const REDACT_SUBSTRINGS = ['token', 'secret', 'key', 'password'] as const;

function redactValue(envKey: string, envValue: string): string {
  const lower = envKey.toLowerCase();
  for (const sub of REDACT_SUBSTRINGS) {
    if (lower.includes(sub)) return '[redacted]';
  }
  return envValue;
}

// ---------------------------------------------------------------------------
// Step kind counters
// ---------------------------------------------------------------------------

interface PlanCounts {
  script: number;
  prompt: number;
  branch: number;
  other: number;
}

// ---------------------------------------------------------------------------
// Per-step plan printers
// ---------------------------------------------------------------------------

async function printPromptStep(num: number, step: PromptStep, lines: string[]): Promise<void> {
  lines.push(
    `  ${dim(String(num).padStart(2, ' '))}  ${green(step.id.padEnd(24))}  ${dim('prompt')}`,
  );

  const file = step.promptFile;
  let exists = false;
  try {
    await access(file);
    exists = true;
  } catch {
    exists = false;
  }

  const fileStatus = exists
    ? `${SYMBOLS.ok}  ${file}`
    : `${SYMBOLS.warn}  ${file}  ${yellow('(file not found)')}`;

  lines.push(`       prompt  ${fileStatus}`);
}

function printScriptLikeStep(num: number, step: ScriptStep | BranchStep, lines: string[]): void {
  const kindLabel = step.kind === 'branch' ? 'branch' : 'script';
  lines.push(
    `  ${dim(String(num).padStart(2, ' '))}  ${green(step.id.padEnd(24))}  ${dim(kindLabel)}`,
  );

  const run = Array.isArray(step.run) ? step.run.join(' ') : step.run;
  lines.push(`       run     ${run}`);

  const env = step.env;
  if (env !== undefined && Object.keys(env).length > 0) {
    lines.push(`       env`);
    for (const [k, v] of Object.entries(env)) {
      const displayed = redactValue(k, v);
      lines.push(`               ${k}=${displayed}`);
    }
  }
}

function printOtherStep(num: number, step: Step, lines: string[]): void {
  lines.push(
    `  ${dim(String(num).padStart(2, ' '))}  ${green(step.id.padEnd(24))}  ${dim(step.kind)}`,
  );
}

// ---------------------------------------------------------------------------
// Plan renderer
// ---------------------------------------------------------------------------

async function renderPlan(flow: Flow<unknown>): Promise<string> {
  const lines: string[] = [];

  lines.push(`${MARK}  ${flow.name}  ${dim('dry-run')}`);
  lines.push('');

  const counts: PlanCounts = { script: 0, prompt: 0, branch: 0, other: 0 };

  for (let i = 0; i < flow.stepOrder.length; i++) {
    const stepId = flow.stepOrder[i];
    if (stepId === undefined) continue;
    const step = flow.steps[stepId];
    if (step === undefined) continue;

    const num = i + 1;

    if (step.kind === 'prompt') {
      await printPromptStep(num, step, lines);
      counts.prompt++;
    } else if (step.kind === 'script') {
      printScriptLikeStep(num, step, lines);
      counts.script++;
    } else if (step.kind === 'branch') {
      printScriptLikeStep(num, step, lines);
      counts.branch++;
    } else {
      printOtherStep(num, step, lines);
      counts.other++;
    }

    lines.push('');
  }

  const total = flow.stepOrder.length;
  lines.push(
    dim(
      `${total} ${total === 1 ? 'step' : 'steps'} · ${counts.script} script · ${counts.prompt} prompt · ${counts.branch} branch`,
    ),
  );
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * Entry point dispatched by the CLI for `relay dry-run <flow> [input...]`.
 *
 * @param args  Argv slice after "dry-run": [flowNameOrPath, ...inputArgs]
 * @param _opts Parsed option flags from the dispatcher (unused)
 */
export default async function dryRunCommand(args: unknown[], _opts: unknown): Promise<void> {
  const stringArgs = (args as unknown[]).map(String);
  const nameOrPath: string = stringArgs[0] ?? '';
  const inputArgv: string[] = stringArgs.slice(1);

  if (nameOrPath === '') {
    process.stderr.write(
      red(`${SYMBOLS.fail}  usage: relay dry-run <flow> [input options...]`) + '\n',
    );
    process.exit(EXIT_CODES.runner_failure);
  }

  // Step 1 — load and validate the flow.
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

  // Step 2 — parse input from remaining argv. Failure exits 2.
  const parseResult = parseInputFromArgv(flow.input, inputArgv);
  if (parseResult.isErr()) {
    process.stderr.write(red(`${SYMBOLS.fail}  ${parseResult.error.message}`) + '\n');
    process.exit(EXIT_CODES.definition_error);
  }

  // Step 3 — render the step-by-step plan.
  const plan = await renderPlan(flow as Flow<unknown>);
  process.stdout.write(plan);

  process.exit(EXIT_CODES.success);
}
