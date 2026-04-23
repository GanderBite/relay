import { defineFlow, step, z } from '@relay/core';

export default defineFlow({
  name: 'file-type-router',
  version: '0.1.0',
  description:
    'A routing example: a branch step inspects a file path from the FILE_PATH env var and picks one of three review prompts based on the extension (.ts, .js, or other).',
  input: z.object({}),
  steps: {
    route: step.branch({
      run: [
        'node',
        '-e',
        "const p = process.env.FILE_PATH || ''; const m = p.match(/\\.([^./\\\\]+)$/); const ext = m ? m[1].toLowerCase() : ''; process.exit(ext === 'ts' ? 0 : ext === 'js' ? 1 : 2);",
      ],
      onExit: {
        '0': 'reviewTypescript',
        '1': 'reviewJavascript',
        '2': 'analyzeText',
      },
    }),
    reviewTypescript: step.prompt({
      promptFile: 'prompts/review-typescript.md',
      dependsOn: ['route'],
      output: { artifact: 'review.md' },
    }),
    reviewJavascript: step.prompt({
      promptFile: 'prompts/review-javascript.md',
      dependsOn: ['route'],
      output: { artifact: 'review.md' },
    }),
    analyzeText: step.prompt({
      promptFile: 'prompts/analyze-text.md',
      dependsOn: ['route'],
      output: { artifact: 'review.md' },
    }),
  },
});
