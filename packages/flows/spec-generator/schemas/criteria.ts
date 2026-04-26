import { z } from '@ganderbite/relay-core';

export const CriteriaSchema = z.object({
  acceptanceCriteria: z
    .array(
      z.object({
        id: z.string().describe('Unique identifier, e.g. AC-001.'),
        frRef: z.string().describe('The FR-XXX this criterion validates.'),
        criterion: z.string().describe('Given/When/Then testable criterion.'),
      }),
    )
    .describe('Testable criteria derived from functional requirements.'),
});

export type Criteria = z.infer<typeof CriteriaSchema>;
