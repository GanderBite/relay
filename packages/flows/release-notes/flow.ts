import { defineFlow, step, z } from '@relay/core';

const JSON_ONLY_SYSTEM_PROMPT =
  'Output only raw JSON. Your entire response must be a single valid JSON object — no preamble, no markdown fences, no explanatory text.';

const MARKDOWN_ONLY_SYSTEM_PROMPT =
  'Output only the raw Markdown document. Do not use any tools. Do not write any files. Your entire response must be the document text — no preamble, no commentary, no tool calls.';

export default defineFlow({
  name: 'release-notes',
  version: '0.1.0',
  description:
    "Produces a technical changelog, user-facing what's new doc, and marketing highlights brief from a git commit range.",
  input: z.object({
    fromRef: z.string().describe('Git tag or commit SHA to start from (exclusive).'),
    toRef: z.string().default('HEAD').describe('Git tag or commit SHA to end at (inclusive).'),
    projectName: z.string().describe('Project name used in the output documents.'),
    audiences: z
      .array(z.enum(['technical', 'customer', 'marketing']))
      .default(['technical', 'customer', 'marketing'])
      .describe('Which output documents to generate.'),
  }),
  start: 'parse_commits',
  steps: {
    parse_commits: step.prompt({
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      promptFile: 'prompts/01_parse-commits.md',
      tools: ['Bash'],
      output: { handoff: 'parse_commits' },
    }),
    write_technical: step.prompt({
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      promptFile: 'prompts/02_write-technical.md',
      dependsOn: ['parse_commits'],
      contextFrom: ['parse_commits'],
      output: { handoff: 'write_technical' },
    }),
    write_customer: step.prompt({
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      promptFile: 'prompts/03_write-customer.md',
      dependsOn: ['parse_commits'],
      contextFrom: ['parse_commits'],
      output: { handoff: 'write_customer' },
    }),
    write_marketing: step.prompt({
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      promptFile: 'prompts/04_write-marketing.md',
      dependsOn: ['parse_commits'],
      contextFrom: ['parse_commits'],
      output: { handoff: 'write_marketing' },
    }),
    barrier: step.parallel({
      branches: ['write_technical', 'write_customer', 'write_marketing'],
      dependsOn: ['write_technical', 'write_customer', 'write_marketing'],
    }),
    cross_check: step.prompt({
      systemPrompt: MARKDOWN_ONLY_SYSTEM_PROMPT,
      promptFile: 'prompts/05_cross-check.md',
      dependsOn: ['barrier'],
      contextFrom: ['parse_commits', 'write_technical', 'write_customer', 'write_marketing'],
      output: { artifact: 'release-notes.md' },
    }),
  },
});
