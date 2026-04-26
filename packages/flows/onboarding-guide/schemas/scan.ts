import { z } from '@relay/core';

export const ScanSchema = z.object({
  projectName: z.string().describe('The name declared in the root manifest.'),
  description: z.string().describe('One-sentence project description from the manifest or README.'),
  readmePath: z.string().describe('Repo-relative path to the root README file.'),
  contributingGuidePath: z
    .string()
    .describe('Repo-relative path to CONTRIBUTING.md, or empty string if absent.'),
  docPaths: z
    .array(z.string())
    .describe('Repo-relative paths to all Markdown files other than README and CONTRIBUTING.'),
  manifests: z
    .array(
      z.object({
        path: z.string().describe('Repo-relative path to the manifest file.'),
        name: z.string().describe('Package name declared in the manifest.'),
        language: z
          .string()
          .describe('Primary language of the package (ts, js, py, go, rust, or other).'),
        entryPoints: z.array(z.string()).describe('Repo-relative entry point paths.'),
      }),
    )
    .describe('All package manifests found in the project.'),
  ciFilePaths: z.array(z.string()).describe('Repo-relative paths to CI/CD workflow files.'),
  envVarKeys: z
    .array(z.string())
    .describe('Env var names referenced in docs or CI files, deduplicated.'),
});

export type Scan = z.infer<typeof ScanSchema>;
