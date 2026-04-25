import { z } from '../zod.js';

export const RelaySettings = z.object({ provider: z.string().min(1).optional() }).strict();
export type RelaySettings = z.infer<typeof RelaySettings>;
