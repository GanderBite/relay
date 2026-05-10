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
import { isAbsolute, join } from 'node:path';
import type {
  BranchStep,
  Flow,
  PromptStep,
  ScriptEnvContext,
  ScriptStep,
  Step,
} from '@ganderbite/relay-core';
import { FlowDefinitionError, isScriptEnvFromSpec, resolveScriptEnv } from '@ganderbite/relay-core';
import { MARK, SYMBOLS } from '../brand.js';
import { dim, green, red, yellow } from '../color.js';
import { EXIT_CODES, formatError } from '../exit-codes.js';
import { parseInputFromArgv } from '../input-parser.js';
import { loadFlowOnly } from '../load-flow-and-auth.js';

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

async function printPromptStep(
  num: number,
  step: PromptStep,
  lines: string[],
  dir: string,
): Promise<void> {
  lines.push(
    `  ${dim(String(num).padStart(2, ' '))}  ${green(step.id.padEnd(24))}  ${dim('prompt')}`,
  );

  const file = step.promptFile;
  const fullPath = isAbsolute(file) ? file : join(dir, file);
  let exists = false;
  try {
    await access(fullPath);
    exists = true;
  } catch {
    exists = false;
  }

  const fileStatus = exists
    ? `${SYMBOLS.ok}  ${file}`
    : `${SYMBOLS.warn}  ${file}  ${yellow('(file not found)')}`;

  lines.push(`       prompt  ${fileStatus}`);
}

function printScriptLikeStep(
  num: number,
  step: ScriptStep | BranchStep,
  lines: string[],
  envCtx: ScriptEnvContext,
): void {
  const kindLabel = step.kind === 'branch' ? 'branch' : 'script';
  lines.push(
    `  ${dim(String(num).padStart(2, ' '))}  ${green(step.id.padEnd(24))}  ${dim(kindLabel)}`,
  );

  const run = Array.isArray(step.run) ? step.run.join(' ') : step.run;
  lines.push(`       run     ${run}`);

  // Resolve each env entry independently against the dry-run context.
  // For unresolvable from: sources, print a placeholder rather than failing.
  const rawEnv = step.env;
  const displayEntries: Array<[string, string]> = [];

  // Resolve per entry so a single failure produces one placeholder, not a wholesale skip.
  if (rawEnv !== undefined) {
    for (const [k, spec] of Object.entries(rawEnv)) {
      if (isScriptEnvFromSpec(spec)) {
        // Attempt to resolve this single entry.
        const singleResult = resolveScriptEnv({ [k]: spec }, envCtx);
        if (singleResult.isOk()) {
          const resolved = singleResult.value[k] ?? '';
          // Empty string means the optional source was absent — show placeholder.
          displayEntries.push([k, resolved === '' ? `<from: ${spec.from}>` : resolved]);
        } else {
          // Unresolvable (e.g. required source missing) — show placeholder.
          displayEntries.push([k, `<from: ${spec.from}>`]);
        }
      } else {
        // String template value — resolve as a single-entry map.
        const singleResult = resolveScriptEnv({ [k]: spec }, envCtx);
        if (singleResult.isOk()) {
          displayEntries.push([k, singleResult.value[k] ?? spec]);
        } else {
          // Template render failed — show raw template text.
          displayEntries.push([k, spec]);
        }
      }
    }
  }

  // Auto-injected RELAY_* vars.
  const relayEntries: Array<[string, string]> = [
    ['RELAY_RUN_DIR', envCtx.runDir],
    ['RELAY_FLOW_DIR', envCtx.flowDir],
    ['RELAY_HANDOFFS_DIR', envCtx.handoffsDir],
    ['RELAY_INPUT_JSON', join(envCtx.runDir, 'live', `${step.id}.input.json`)],
  ];

  const hasUserEnv = displayEntries.length > 0;
  const hasEnv = hasUserEnv || relayEntries.length > 0;

  if (hasEnv) {
    lines.push(`       env`);
    for (const [k, v] of displayEntries) {
      const displayed = redactValue(k, v);
      lines.push(`               ${k}=${displayed}`);
    }
    for (const [k, v] of relayEntries) {
      lines.push(`               ${dim(k)}=${dim(v)}`);
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

async function renderPlan(
  flow: Flow<unknown>,
  dir: string,
  input: Record<string, unknown>,
): Promise<string> {
  const lines: string[] = [];

  lines.push(`${MARK}  ${flow.name}  ${dim('dry-run')}`);
  lines.push('');

  // Build the dry-run ScriptEnvContext. runDir is a placeholder since no run
  // has been started; flowDir is the real loaded directory.
  const envCtx: ScriptEnvContext = {
    input,
    handoffs: {},
    runDir: '<runDir>',
    flowDir: dir,
    handoffsDir: '<runDir>/handoffs',
  };

  const counts: PlanCounts = { script: 0, prompt: 0, branch: 0, other: 0 };

  for (let i = 0; i < flow.graph.topoOrder.length; i++) {
    const stepId = flow.graph.topoOrder[i];
    if (stepId === undefined) continue;
    const step = flow.steps[stepId];
    if (step === undefined) continue;

    const num = i + 1;

    if (step.kind === 'prompt') {
      await printPromptStep(num, step, lines, dir);
      counts.prompt++;
    } else if (step.kind === 'script') {
      printScriptLikeStep(num, step, lines, envCtx);
      counts.script++;
    } else if (step.kind === 'branch') {
      printScriptLikeStep(num, step, lines, envCtx);
      counts.branch++;
    } else {
      printOtherStep(num, step, lines);
      counts.other++;
    }

    lines.push('');
  }

  const total = flow.graph.topoOrder.length;
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
  const stringArgs = args.map(String);
  const nameOrPath: string = stringArgs[0] ?? '';
  const inputArgv: string[] = stringArgs.slice(1);

  if (nameOrPath === '') {
    process.stderr.write(
      red(`${SYMBOLS.fail}  usage: relay dry-run <flow> [input options...]`) + '\n',
    );
    process.exit(EXIT_CODES.runner_failure);
  }

  // Step 1 — load and validate the flow.
  const loadResult = await loadFlowOnly({ cwd: process.cwd(), nameOrPath });

  if (loadResult.isErr()) {
    const loadErr = loadResult.error;
    const code =
      loadErr instanceof FlowDefinitionError
        ? EXIT_CODES.definition_error
        : EXIT_CODES.runner_failure;
    process.stderr.write(formatError(loadErr) + '\n');
    process.exit(code);
  }

  const { flow, flowDir: dir } = loadResult.value;

  // Step 2 — parse input from remaining argv. Failure exits 2.
  const parseResult = parseInputFromArgv(flow.input, inputArgv);
  if (parseResult.isErr()) {
    process.stderr.write(red(`${SYMBOLS.fail}  ${parseResult.error.message}`) + '\n');
    process.exit(EXIT_CODES.definition_error);
  }

  // Step 3 — render the step-by-step plan.
  const plan = await renderPlan(
    flow as Flow<unknown>,
    dir,
    parseResult.value as Record<string, unknown>,
  );
  process.stdout.write(plan);

  process.exit(EXIT_CODES.success);
}
