import { defineFlow, step, z } from '@relay/core';
import { ExploreSchema } from './schemas/explore.js';
import { GuideSectionsSchema } from './schemas/guide-sections.js';
import { PracticesSchema } from './schemas/practices.js';
import { ScanSchema } from './schemas/scan.js';

const JSON_ONLY_SYSTEM_PROMPT =
  'Output only raw JSON. Your entire response must be a single valid JSON object — no preamble, no markdown fences, no explanatory text.';

export default defineFlow({
  name: 'onboarding-guide',
  version: '0.1.0',
  description: 'Scans a project directory and produces an audience-specific HTML onboarding guide.',
  input: z.object({
    projectDir: z.string().describe('Absolute path to the project directory to document.'),
    audience: z
      .enum(['developer', 'pm', 'qa', 'client'])
      .default('developer')
      .describe('Target audience for the guide.'),
  }),
  steps: {
    scan: step.prompt({
      promptFile: 'prompts/01_scan.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      output: { handoff: 'scan', schema: ScanSchema },
      maxRetries: 1,
    }),

    explore: step.prompt({
      promptFile: 'prompts/02_explore.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      dependsOn: ['scan'],
      contextFrom: ['scan'],
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      output: { handoff: 'explore', schema: ExploreSchema },
    }),

    'extract-practices': step.prompt({
      promptFile: 'prompts/03_extract-practices.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      dependsOn: ['explore'],
      contextFrom: ['scan', 'explore'],
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      output: { handoff: 'practices', schema: PracticesSchema },
    }),

    'write-guide': step.prompt({
      promptFile: 'prompts/04_write-guide.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      dependsOn: ['extract-practices'],
      contextFrom: ['scan', 'explore', 'practices'],
      output: { handoff: 'guide', schema: GuideSectionsSchema },
    }),

    render: step.prompt({
      promptFile: 'prompts/05_render.md',
      dependsOn: ['write-guide'],
      contextFrom: ['guide'],
      output: { artifact: 'guide.html' },
      systemPrompt:
        'Output only the raw HTML document. Do not use any tools. Do not write any files. Your entire response must be the document text — no preamble, no commentary, no tool calls.',
    }),
  },
});
