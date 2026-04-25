import { z } from '@relay/core';

export const ServicesSchema = z.object({
  services: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      usedBy: z.array(z.string()),
    }),
  ),
});
