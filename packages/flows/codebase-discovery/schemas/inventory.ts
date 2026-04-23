import { z } from '@relay/core';

export const InventorySchema = z.object({
  packages: z.array(
    z.object({
      path: z.string(),
      name: z.string(),
      language: z.enum(['ts', 'py', 'go', 'rust', 'other']),
      entryPoints: z.array(z.string()),
    }),
  ),
});

export type Inventory = z.infer<typeof InventorySchema>;
