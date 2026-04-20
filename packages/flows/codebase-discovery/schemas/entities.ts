import { z } from '@relay/core';

export const EntitiesSchema = z.object({
  entities: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(['model', 'service', 'controller', 'util']),
      package: z.string(),
      description: z.string(),
    }),
  ),
});

export type Entities = z.infer<typeof EntitiesSchema>;
