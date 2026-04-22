import { z } from '@relay/core';

/**
 * The shape of the `inventory` baton written by the first runner.
 * Downstream runners receive this object as an injected context block and
 * should read it as `{{inventory.packages}}` from within a prompt.
 */
export const InventorySchema = z.object({
  packages: z.array(
    z.object({
      path: z.string().describe('Repo-relative path to the package root.'),
      name: z.string().describe('The package name as declared in its manifest.'),
      language: z
        .enum(['ts', 'js', 'py', 'go', 'rust', 'other'])
        .describe('Primary language of the package.'),
      entryPoints: z
        .array(z.string())
        .describe('Repo-relative paths to the package entry points.'),
    }),
  ),
});

export type Inventory = z.infer<typeof InventorySchema>;
