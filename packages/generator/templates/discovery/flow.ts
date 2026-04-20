import { defineFlow, step, z } from '@relay/core';
import { InventorySchema } from './schemas/inventory.js';
import { EntitiesSchema } from './schemas/entities.js';

export default defineFlow({
  name: '{{pkgName}}',
  version: '0.1.0',
  description: 'Explores a codebase and produces an HTML report.',
  input: z.object({
    repoPath: z.string().describe('Absolute path to the repository to explore.'),
    audience: z
      .enum(['pm', 'dev', 'both'])
      .default('both')
      .describe('Who the report is written for.'),
  }),
  steps: {
    inventory: step.prompt({
      promptFile: 'prompts/01_inventory.md',
      tools: ['Read', 'Glob', 'Grep'],
      output: { handoff: 'inventory', schema: InventorySchema },
      maxRetries: 1,
    }),

    entities: step.prompt({
      promptFile: 'prompts/02_entities.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'entities', schema: EntitiesSchema },
    }),

    services: step.prompt({
      promptFile: 'prompts/03_services.md',
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { handoff: 'services' },
    }),

    report: step.prompt({
      promptFile: 'prompts/04_report.md',
      dependsOn: ['entities', 'services'],
      contextFrom: ['inventory', 'entities', 'services'],
      output: { artifact: 'report.html' },
    }),
  },
});
