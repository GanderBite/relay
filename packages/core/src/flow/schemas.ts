import { z } from '../zod.js';
import type {
  BranchStepSpec,
  ParallelStepSpec,
  PromptStepOutput,
  PromptStepSpec,
  ScriptStepSpec,
  TerminalStepSpec,
} from './types.js';

// Primitive building blocks — semantically distinct even though both require
// a non-empty string today. Keep them separate so tightening one does not
// silently affect the other.
const nonEmptyString = z.string().min(1);
const stepId = nonEmptyString;
const runCommand = z.union([nonEmptyString, z.array(nonEmptyString).min(1)]);

const zodSchemaValue = z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
  error: 'expected a Zod schema (instance of z.ZodType)',
});

// onExit key: either the literal "default" or a numeric exit-code string.
const onExitKey = z.union([z.literal('default'), z.string().regex(/^\d+$/)]);

// onExit/onFail values shared by prompt, script, and branch steps.
const onExitValue = z.union([z.literal('abort'), z.literal('continue'), stepId]);
const onFailValue = z.union([z.literal('abort'), z.literal('continue'), stepId]);

// Output variant for prompt steps. Modelled as an explicit union of the three
// shapes the spec enumerates — no single-object-with-refine shortcut that
// could admit a fourth combination.
export const promptOutputSchema: z.ZodType<PromptStepOutput> = z.union([
  z.strictObject({
    handoff: nonEmptyString,
    schema: zodSchemaValue.optional(),
  }),
  z.strictObject({
    artifact: nonEmptyString,
  }),
  z.strictObject({
    handoff: nonEmptyString,
    artifact: nonEmptyString,
    schema: zodSchemaValue.optional(),
  }),
]);

// Bounds the worst-case billing for a runaway prompt. Every prompt step
// gets this default unless the author overrides it. The Step also applies
// the same fallback at dispatch time so races that bypass this schema
// (e.g. spec literals) still inherit the bound, but persisting it on the
// parsed PromptStepSpec keeps the value visible to downstream tooling
// (catalog linter, doctor command) that reads steps without re-running them.
const DEFAULT_PROMPT_TIMEOUT_MS = 600_000;

export const promptStepSpecSchema: z.ZodType<PromptStepSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('prompt'),
  promptFile: nonEmptyString,
  dependsOn: z.array(stepId).optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  contextFrom: z.array(stepId).optional(),
  output: promptOutputSchema,
  maxRetries: z.number().int().nonnegative().optional(),
  maxBudgetUsd: z.number().optional(),
  timeoutMs: z.number().int().nonnegative().default(DEFAULT_PROMPT_TIMEOUT_MS),
  onFail: onFailValue.optional(),
});

export const scriptStepSpecSchema: z.ZodType<ScriptStepSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('script'),
  run: runCommand,
  dependsOn: z.array(stepId).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  output: z.strictObject({ artifact: stepId.optional() }).optional(),
  onExit: z.record(onExitKey, onExitValue).optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  onFail: onFailValue.optional(),
});

export const branchStepSpecSchema: z.ZodType<BranchStepSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('branch'),
  run: runCommand,
  dependsOn: z.array(stepId).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  onExit: z.record(onExitKey, onExitValue).refine((o) => Object.keys(o).length > 0, {
    message: 'branch step requires a non-empty `onExit` map',
  }),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  onFail: onFailValue.optional(),
});

// Parallel steps do not support retry, timeout, context injection, or
// `onFail: 'continue'`. The onFail union matches the spec exactly.
export const parallelStepSpecSchema: z.ZodType<ParallelStepSpec> = z
  .strictObject({
    id: z.string(),
    kind: z.literal('parallel'),
    branches: z.array(stepId).min(1),
    dependsOn: z.array(stepId).optional(),
    onAllComplete: stepId.optional(),
    onFail: z.union([z.literal('abort'), stepId]).optional(),
  })
  .refine((spec) => new Set(spec.branches).size === spec.branches.length, {
    message: 'parallel branches must be unique',
    path: ['branches'],
  });

// Terminal steps end the flow — no retry, timeout, output, or onFail.
export const terminalStepSpecSchema: z.ZodType<TerminalStepSpec> = z.strictObject({
  id: z.string(),
  kind: z.literal('terminal'),
  dependsOn: z.array(stepId).optional(),
  message: z.string().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
});

export const flowSpecInputSchema = z.strictObject({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, { error: 'flow name must be kebab-case' }),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    error: 'flow version must be semver-ish (e.g. 1.0.0)',
  }),
  description: z.string().optional(),
  input: zodSchemaValue,
  steps: z.record(stepId, z.unknown()).refine((o) => Object.keys(o).length > 0, {
    message: 'flow "steps" must be a non-empty object',
  }),
  start: stepId.optional(),
});
