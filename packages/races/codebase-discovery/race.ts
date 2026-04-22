import { defineRace, runner, z } from '@relay/core';
import { EntitiesSchema } from './schemas/entities.js';
import { InventorySchema } from './schemas/inventory.js';

export default defineRace({
  name: 'codebase-discovery',
  version: '0.1.0',
  description: 'Explores a codebase and produces an HTML report of packages, entities, services, and architecture.',
  input: z.object({
    repoPath: z.string().describe('Absolute or relative path to the repository to analyze.'),
    audience: z
      .enum(['pm', 'dev', 'both'])
      .default('both')
      .describe('Who the report is written for: product managers, developers, or both.'),
  }),
  runners: {
    inventory: runner.prompt({
      promptFile: 'prompts/01_inventory.md',
      tools: ['Read', 'Glob', 'Grep'],
      output: { baton: 'inventory', schema: InventorySchema },
    }),
    entities: runner.prompt({
      promptFile: 'prompts/02_entities.md',
      tools: ['Read', 'Glob', 'Grep'],
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { baton: 'entities', schema: EntitiesSchema },
    }),
    services: runner.prompt({
      promptFile: 'prompts/03_services.md',
      tools: ['Read', 'Glob', 'Grep'],
      dependsOn: ['inventory'],
      contextFrom: ['inventory'],
      output: { baton: 'services' },
    }),
    report: runner.prompt({
      promptFile: 'prompts/04_report.md',
      dependsOn: ['entities', 'services'],
      contextFrom: ['inventory', 'entities', 'services'],
      output: { artifact: 'report.html' },
    }),
  },
});
