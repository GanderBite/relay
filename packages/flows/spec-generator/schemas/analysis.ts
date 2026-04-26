import { z } from '@ganderbite/relay-core';

export const AnalysisSchema = z.object({
  featureName: z
    .string()
    .describe('Short kebab-case identifier for the feature, e.g. user-deletion.'),
  domain: z.string().describe('The problem domain or system area this feature belongs to.'),
  actors: z.array(z.string()).describe('Roles or systems that interact with this feature.'),
  keyBehaviors: z
    .array(z.string())
    .describe('Core behavioral requirements in plain language, one per item.'),
  constraints: z.array(z.string()).describe('Known technical or business constraints.'),
  summary: z
    .string()
    .describe('2-3 sentence description of what this feature does and why it exists.'),
});

export type Analysis = z.infer<typeof AnalysisSchema>;
