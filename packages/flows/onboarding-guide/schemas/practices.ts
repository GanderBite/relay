import { z } from '@ganderbite/relay-core';

export const PracticesSchema = z.object({
  architecturePattern: z.object({
    name: z.string().describe('Pattern name (MVC, hexagonal, layered, event-driven, etc.).'),
    layers: z
      .array(
        z.object({
          name: z.string().describe('Layer name.'),
          modules: z.array(z.string()).describe('Module names that implement this layer.'),
        }),
      )
      .describe('Ordered layers from outermost to innermost.'),
  }),
  gitConventions: z.object({
    commitFormat: z.string().describe('Exact commit message format or convention.'),
    mergeStrategy: z.string().describe('squash, rebase, or merge.'),
    branchNaming: z.string().describe('Branch naming convention.'),
  }),
  errorHandling: z.object({
    pattern: z
      .string()
      .describe('How errors are represented and propagated (throw, Result, etc.).'),
    canonicalFile: z
      .string()
      .catch('')
      .describe('Repo-relative path to the canonical error definition, or empty string.'),
  }),
  testing: z.object({
    framework: z.string().describe('Test framework name.'),
    layout: z.string().describe('co-located or separate.'),
    coverageTarget: z.string().catch('').describe('Coverage target if stated, or empty string.'),
  }),
  documentationConvention: z
    .string()
    .describe('How code is documented (JSDoc, inline comments, ADRs, etc.).'),
  ciCdPipeline: z.object({
    onPush: z.array(z.string()).describe('Jobs that run on every push.'),
    requiredToMerge: z.array(z.string()).describe('Checks required before a merge is allowed.'),
  }),
  localSetup: z.object({
    prerequisites: z.array(z.string()).describe('Tools or accounts needed before setup.'),
    steps: z.array(z.string()).describe('Ordered shell commands to run the project locally.'),
  }),
  gotchas: z.array(z.string()).describe('Common mistakes, footguns, or non-obvious constraints.'),
});

export type Practices = z.infer<typeof PracticesSchema>;
