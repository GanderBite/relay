import { z } from '@ganderbite/relay-core';

/**
 * The shape of the `entities` handoff written by the `entities` branch.
 * The report step receives this alongside `inventory` and `services`.
 */
export const EntitiesSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string().describe('The entity identifier (class, function, type).'),
      kind: z
        .enum(['model', 'service', 'controller', 'util'])
        .describe('The architectural role the entity plays.'),
      file: z.string().describe('Repo-relative path to the file that defines it.'),
      summary: z.string().describe('One-sentence description of what the entity does.'),
    }),
  ),
});

export type Entities = z.infer<typeof EntitiesSchema>;
