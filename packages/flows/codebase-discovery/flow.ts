import { defineFlow, step, z } from '@relay/core';
import { EntitiesSchema } from './schemas/entities.js';
import { InventorySchema } from './schemas/inventory.js';

const inventory = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/01_inventory.md',
  tools: ['Read', 'Glob', 'Grep'],
  output: { handoff: 'inventory', schema: InventorySchema },
} as Parameters<typeof step.prompt>[0]);

const entities = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/02_entities.md',
  tools: ['Read', 'Glob', 'Grep'],
  dependsOn: ['inventory'],
  contextFrom: ['inventory'],
  output: { handoff: 'entities', schema: EntitiesSchema },
} as Parameters<typeof step.prompt>[0]);

const services = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/03_services.md',
  tools: ['Read', 'Glob', 'Grep'],
  dependsOn: ['inventory'],
  contextFrom: ['inventory'],
  output: { handoff: 'services' },
} as Parameters<typeof step.prompt>[0]);

const report = step.prompt({
  kind: 'prompt',
  promptFile: 'prompts/04_report.md',
  dependsOn: ['entities', 'services'],
  contextFrom: ['inventory', 'entities', 'services'],
  output: { artifact: 'report.html' },
} as Parameters<typeof step.prompt>[0]);

const flowResult = defineFlow({
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
  steps: {
    inventory: inventory._unsafeUnwrap(),
    entities: entities._unsafeUnwrap(),
    services: services._unsafeUnwrap(),
    report: report._unsafeUnwrap(),
  },
});

if (flowResult.isErr()) {
  throw new Error(`codebase-discovery flow definition failed: ${flowResult.error.message}`);
}

export default flowResult.value;
