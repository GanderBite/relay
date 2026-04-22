import { z } from '../zod.js';
import type {
  BranchRunnerSpec,
  ParallelRunnerSpec,
  PromptRunnerOutput,
  PromptRunnerSpec,
  ScriptRunnerSpec,
  TerminalRunnerSpec,
} from './types.js';

// Primitive building blocks — semantically distinct even though both require
// a non-empty string today. Keep them separate so tightening one does not
// silently affect the other.
const nonEmptyString = z.string().min(1);
const runnerId = nonEmptyString;
const runCommand = z.union([nonEmptyString, z.array(nonEmptyString).min(1)]);

const zodSchemaValue = z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
  error: 'expected a Zod schema (instance of z.ZodType)',
});

// onExit key: either the literal "default" or a numeric exit-code string.
const onExitKey = z.union([z.literal('default'), z.string().regex(/^\d+$/)]);

// onExit/onFail values shared by prompt, script, and branch steps.
const onExitValue = z.union([z.literal('abort'), z.literal('continue'), runnerId]);
const onFailValue = z.union([z.literal('abort'), z.literal('continue'), runnerId]);

// Output variant for prompt steps. Modelled as an explicit union of the three
// shapes the spec enumerates — no single-object-with-refine shortcut that
// could admit a fourth combination.
export const promptOutputSchema: z.ZodType<PromptRunnerOutput> = z.union([
  z.strictObject({
    baton: nonEmptyString,
    schema: zodSchemaValue.optional(),
  }),
  z.strictObject({
    artifact: nonEmptyString,
  }),
  z.strictObject({
    baton: nonEmptyString,
    artifact: nonEmptyString,
    schema: zodSchemaValue.optional(),
  }),
]);

// Bounds the worst-case billing for a runaway prompt. Per spec §4.4.1, every
// prompt runner gets this default unless the author overrides it. The Runner
// also applies the same fallback at dispatch time so flows that bypass this
// schema (e.g. spec literals) still inherit the bound, but persisting it on
// the parsed PromptRunnerSpec keeps the value visible to downstream tooling
// (catalog linter, doctor command) that reads steps without re-running them.
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;

export const promptRunnerSpecSchema: z.ZodType<PromptRunnerSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('prompt'),
  promptFile: nonEmptyString,
  dependsOn: z.array(runnerId).optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  contextFrom: z.array(runnerId).optional(),
  output: promptOutputSchema,
  maxRetries: z.number().int().nonnegative().optional(),
  maxBudgetUsd: z.number().optional(),
  timeoutMs: z.number().int().nonnegative().default(DEFAULT_PROMPT_TIMEOUT_MS),
  onFail: onFailValue.optional(),
});

export const scriptRunnerSpecSchema: z.ZodType<ScriptRunnerSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('script'),
  run: runCommand,
  dependsOn: z.array(runnerId).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  output: z.strictObject({ artifact: runnerId.optional() }).optional(),
  onExit: z.record(onExitKey, onExitValue).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  onFail: onFailValue.optional(),
});

export const branchRunnerSpecSchema: z.ZodType<BranchRunnerSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('branch'),
  run: runCommand,
  dependsOn: z.array(runnerId).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  onExit: z.record(onExitKey, onExitValue).refine(
    (o) => Object.keys(o).length > 0,
    { message: 'branch runner requires a non-empty `onExit` map' },
  ),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  onFail: onFailValue.optional(),
});

// Parallel steps do not support retry, timeout, context injection, or
// `onFail: 'continue'`. The onFail union matches the spec exactly.
export const parallelRunnerSpecSchema: z.ZodType<ParallelRunnerSpec> = z
  .strictObject({
    id: z.string(),
    kind: z.literal('parallel'),
    branches: z.array(runnerId).min(1),
    dependsOn: z.array(runnerId).optional(),
    onAllComplete: runnerId.optional(),
    onFail: z.union([z.literal('abort'), runnerId]).optional(),
  })
  .refine(
    (spec) => new Set(spec.branches).size === spec.branches.length,
    { message: 'parallel branches must be unique', path: ['branches'] },
  );

// Terminal steps end the race — no retry, timeout, output, or onFail.
export const terminalRunnerSpecSchema: z.ZodType<TerminalRunnerSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('terminal'),
  dependsOn: z.array(runnerId).optional(),
  message: z.string().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
});

export const raceSpecInputSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, { error: 'race name must be kebab-case' }),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    error: 'race version must be semver-ish (e.g. 1.0.0)',
  }),
  description: z.string().optional(),
  input: zodSchemaValue,
  runners: z.record(runnerId, z.unknown()).refine((o) => Object.keys(o).length > 0, {
    message: 'race "runners" must be a non-empty object',
  }),
  start: runnerId.optional(),
});
