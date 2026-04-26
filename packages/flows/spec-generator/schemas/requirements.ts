import { z } from '@relay/core';

const RequirementSchema = z.object({
  id: z.string().describe('Unique identifier, e.g. FR-001.'),
  description: z.string().describe('Precise, testable requirement statement.'),
});

const ErrorHandlingItemSchema = z.object({
  id: z.string().describe('Unique identifier, e.g. EH-001.'),
  scenario: z.string().describe('The error condition that triggers this response.'),
  response: z.string().describe('The exact system response — status code, message, side effects.'),
});

export const RequirementsSchema = z.object({
  functionalRequirements: z.array(RequirementSchema).describe('What the feature must do.'),
  nonFunctionalRequirements: z
    .array(RequirementSchema)
    .describe('Performance, scalability, and reliability requirements.'),
  edgeCases: z
    .array(RequirementSchema)
    .describe('Boundary conditions and expected behavior at each boundary.'),
  validationRules: z.array(RequirementSchema).describe('Input constraints and rejection behavior.'),
  errorHandling: z
    .array(ErrorHandlingItemSchema)
    .describe('Error scenarios and expected system responses.'),
  authorization: z.array(RequirementSchema).describe('Role and permission requirements.'),
});

export type Requirements = z.infer<typeof RequirementsSchema>;
