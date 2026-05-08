import { z } from '@ganderbite/relay-core';

export const DocumentSchema = z.object({
  document: z.string(),
});

export type Document = z.infer<typeof DocumentSchema>;
