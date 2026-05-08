import { z } from '@ganderbite/relay-core';

export const CommitTypeSchema = z.enum([
  'feat',
  'fix',
  'chore',
  'docs',
  'refactor',
  'test',
  'perf',
  'deps',
  'ci',
  'build',
  'other',
]);

export const ParseCommitsSchema = z.object({
  fromRef: z.string(),
  toRef: z.string(),
  projectName: z.string(),
  commits: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      type: CommitTypeSchema,
      scope: z.string().nullable(),
      description: z.string(),
      breaking: z.boolean(),
      migrationNote: z.string().nullable(),
    }),
  ),
  counts: z.object({
    feat: z.number(),
    fix: z.number(),
    breaking: z.number(),
    deps: z.number(),
    other: z.number(),
  }),
  breakingChanges: z.array(
    z.object({
      sha: z.string(),
      subject: z.string(),
      migrationNote: z.string().nullable(),
    }),
  ),
});

export type ParseCommits = z.infer<typeof ParseCommitsSchema>;
