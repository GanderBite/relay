import { defineFlow, step, z } from '@ganderbite/relay-core';
import { AnalysisSchema } from './schemas/analysis.js';
import { CriteriaSchema } from './schemas/criteria.js';
import { RequirementsSchema } from './schemas/requirements.js';

const JSON_ONLY_SYSTEM_PROMPT =
  'Output only raw JSON. Your entire response must be a single valid JSON object — no preamble, no markdown fences, no explanatory text.';

export default defineFlow({
  name: 'spec-generator',
  version: '0.1.0',
  description: 'Generates a structured feature specification from a plain-language description.',
  input: z.object({
    featureDescription: z
      .string()
      .describe('Plain-language description of the feature to specify.'),
  }),
  steps: {
    analyze: step.prompt({
      promptFile: 'prompts/01_analyze.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      output: { handoff: 'analyze', schema: AnalysisSchema },
    }),
    'expand-requirements': step.prompt({
      promptFile: 'prompts/02_expand-requirements.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      dependsOn: ['analyze'],
      contextFrom: ['analyze'],
      output: { handoff: 'requirements', schema: RequirementsSchema },
    }),
    'derive-criteria': step.prompt({
      promptFile: 'prompts/03_derive-criteria.md',
      systemPrompt: JSON_ONLY_SYSTEM_PROMPT,
      dependsOn: ['expand-requirements'],
      contextFrom: ['analyze', 'requirements'],
      output: { handoff: 'criteria', schema: CriteriaSchema },
    }),
    'write-spec': step.prompt({
      promptFile: 'prompts/04_write-spec.md',
      dependsOn: ['derive-criteria'],
      contextFrom: ['analyze', 'requirements', 'criteria'],
      output: { artifact: 'feature-spec.md' },
    }),
  },
});
