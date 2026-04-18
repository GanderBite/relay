import { z } from '../zod.js';

const stepId = z.string().min(1);
const stepIdList = z.array(stepId);
const onExitKey = z.union([z.literal('default'), z.string().regex(/^\d+$/)]);
const onExitValue = z.union([z.literal('abort'), z.literal('continue'), stepId]);
const onFailValue = z.union([z.literal('abort'), z.literal('continue'), stepId]);
const runCommand = z.union([stepId, z.array(stepId).min(1)]);
const zodSchemaValue = z.custom<z.ZodType>((v) => v instanceof z.ZodType, {
  error: 'expected a Zod schema (instance of z.ZodType)',
});

const stepBase = {
  dependsOn: stepIdList.optional(),
  onFail: onFailValue.optional(),
  maxRetries: z.number().int().nonnegative().optional(),
  timeoutMs: z.number().int().nonnegative().optional(),
  contextFrom: stepIdList.optional(),
};

export const promptOutputSchema = z
  .strictObject({
    handoff: stepId.optional(),
    artifact: stepId.optional(),
    schema: zodSchemaValue.optional(),
  })
  .refine((o) => o.handoff !== undefined || o.artifact !== undefined, {
    error: 'prompt step output must declare at least one of "handoff" or "artifact"',
  });

export const promptStepSpecSchema = z.object({
  ...stepBase,
  promptFile: stepId,
  output: promptOutputSchema,
  provider: z.string().optional(),
  model: z.string().optional(),
  tools: z.array(z.string()).optional(),
  systemPrompt: z.string().optional(),
  maxBudgetUsd: z.number().optional(),
  providerOptions: z.record(z.string(), z.unknown()).optional(),
});

export const scriptStepSpecSchema = z.object({
  ...stepBase,
  run: runCommand,
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  output: z.object({ artifact: stepId.optional() }).optional(),
  onExit: z.record(onExitKey, onExitValue).optional(),
});

export const branchStepSpecSchema = z.object({
  ...stepBase,
  run: runCommand,
  cwd: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  onExit: z.record(onExitKey, onExitValue).refine((o) => Object.keys(o).length > 0, {
    error: 'branch step requires a non-empty `onExit` map',
  }),
});

export const parallelStepSpecSchema = z.object({
  ...stepBase,
  branches: z.array(stepId).min(1),
  onAllComplete: stepId.optional(),
});

export const terminalStepSpecSchema = z.object({
  ...stepBase,
  message: z.string().optional(),
  exitCode: z.number().int().min(0).max(255).optional(),
});

export const flowSpecInputSchema = z.object({
  name: z
    .string()
    .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, { error: 'flow name must be kebab-case' }),
  version: z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/, {
    error: 'flow version must be semver-ish (e.g. 1.0.0)',
  }),
  description: z.string().optional(),
  defaultProvider: z.string().optional(),
  input: zodSchemaValue,
  steps: z.record(stepId, z.unknown()).refine((o) => Object.keys(o).length > 0, {
    error: 'flow "steps" must be a non-empty object',
  }),
  start: stepId.optional(),
});
