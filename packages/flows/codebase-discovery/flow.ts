import { defineFlow, step, z } from '@relay/core';
import { EntitiesSchema } from './schemas/entities.js';
import { InventorySchema } from './schemas/inventory.js';
import { ServicesSchema } from './schemas/services.js';

const JSON_ONLY_SYSTEM_PROMPT =
  'Output only raw JSON. Your entire response must be a single valid JSON object — no preamble, no markdown fences, no explanatory text.';

export default defineFlow({
  name: 'codebase-discovery',
  version: '0.1.0',
  description:
    'Explores a codebase and produces an HTML report of packages, entities, services, and architecture.',
  input: z.object({
    repoPath: z.string().describe('Absolute or relative path to the repository to analyze.'),
    audience: z
      .enum(['pm', 'dev', 'both'])
      .default('both')
      .describe('Who the report is written for: product managers, developers, or both.'),
  }),
  steps: {
    inventory: step.prompt({
      promptFile: 'prompts/01_inventory.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      output: { handoff: 'inventory', schema: InventorySchema },
    }),
    entities: step.prompt({
      promptFile: 'prompts/02_entities.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'entities', schema: EntitiesSchema },
    }),
    services: step.prompt({
      promptFile: 'prompts/03_services.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      tools: ['Read', 'Glob', 'Grep', 'Bash'],
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'services', schema: ServicesSchema },
    }),
    report: step.prompt({
      promptFile: 'prompts/04_report.md',
      dependsOn: ['entities', 'services'],
      contextFrom: ['inventory', 'entities', 'services'],
      output: { artifact: 'report.html' },
    }),
  },
});
