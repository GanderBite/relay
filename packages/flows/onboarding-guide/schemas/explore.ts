import { z } from '@ganderbite/relay-core';

export const ExploreSchema = z.object({
  modules: z
    .array(
      z.object({
        package: z.string().describe('Manifest name of the package this module belongs to.'),
        path: z.string().describe('Repo-relative path to the module root.'),
        boundedContext: z
          .string()
          .describe('Domain concern this module owns — and what it does NOT own.'),
        entryPoint: z.string().describe('Repo-relative path to the module main file.'),
        keyExports: z.array(z.string()).describe('Primary exported names.'),
        summary: z.string().describe('One-sentence responsibility statement.'),
      }),
    )
    .describe('Top-level modules mapped across all packages.'),
  packageDependencies: z
    .array(
      z.object({
        from: z.string().describe('Importing package name.'),
        to: z.string().describe('Imported package name.'),
        kind: z.string().describe('Coupling kind: runtime, dev, or peer.'),
      }),
    )
    .describe('Inter-package dependency edges.'),
});

export type Explore = z.infer<typeof ExploreSchema>;
