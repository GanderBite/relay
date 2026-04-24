import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'multi-perspective-review',
  version: '0.1.0',
  description:
    'Five-step fan-out / fan-in flow: three reviewers inspect the same source file in parallel (security, performance, readability), then an aggregation step synthesizes their handoffs into a single report.',
  input: z.object({
    filePath: z.string().describe('Absolute path to the source file the reviewers should read.'),
  }),
  steps: {
    reviewSecurity: step.prompt({
      promptFile: 'prompts/security-review.md',
      output: { handoff: 'security' },
    }),
    reviewPerformance: step.prompt({
      promptFile: 'prompts/performance-review.md',
      output: { handoff: 'performance' },
    }),
    reviewReadability: step.prompt({
      promptFile: 'prompts/readability-review.md',
      output: { handoff: 'readability' },
    }),
    fanOut: step.parallel({
      branches: ['reviewSecurity', 'reviewPerformance', 'reviewReadability'],
      onAllComplete: 'aggregate',
    }),
    aggregate: step.prompt({
      promptFile: 'prompts/aggregate-reviews.md',
      dependsOn: ['reviewSecurity', 'reviewPerformance', 'reviewReadability'],
      contextFrom: ['security', 'performance', 'readability'],
      output: { artifact: 'report.md' },
    }),
  },
});
