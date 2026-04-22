import { z } from '../zod.js';

export const RelaySettings = z.object({ provider: z.string().min(1).optional() }).passthrough();
export type RelaySettings = z.infer<typeof RelaySettings>;
