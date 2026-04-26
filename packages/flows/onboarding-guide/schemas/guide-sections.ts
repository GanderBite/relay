import { z } from '@ganderbite/relay-core';

export const GuideSectionsSchema = z.object({
  audience: z
    .enum(['developer', 'pm', 'qa', 'client'])
    .describe('The audience this guide is written for.'),
  projectName: z.string().describe('The project name, shown in the HTML title and header.'),
  sections: z
    .array(
      z.object({
        title: z.string().describe('Section heading shown in the guide.'),
        content: z.string().describe('Section body as Markdown prose.'),
        priority: z
          .enum(['critical', 'important', 'reference'])
          .catch('important')
          .describe('How urgently a new hire needs this section.'),
      }),
    )
    .describe('Ordered guide sections, from most to least urgent.'),
  dayOneTasks: z
    .array(
      z.object({
        task: z.string().describe('Concrete action to take.'),
        category: z
          .enum(['setup', 'read', 'explore', 'ask', 'do'])
          .catch('do')
          .describe('Kind of action.'),
        estimatedMinutes: z.coerce.number().int().describe('Rough time estimate in minutes.'),
        why: z.string().describe('Why this matters on day one.'),
      }),
    )
    .describe('Ordered checklist of day-one actions for the target audience.'),
  glossary: z
    .array(
      z.object({
        term: z.string().describe('Domain or technical term.'),
        definition: z.string().describe('Plain-language definition.'),
      }),
    )
    .describe('Key terms a newcomer will encounter.'),
});

export type GuideSections = z.infer<typeof GuideSectionsSchema>;
