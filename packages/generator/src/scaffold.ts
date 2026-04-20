import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from 'neverthrow';

export type TemplateId = 'blank' | 'linear' | 'fan-out' | 'discovery';

export interface ScaffoldReport {
  filesWritten: string[];
}

export type ScaffoldError =
  | { kind: 'file-exists'; path: string }
  | { kind: 'template-not-found'; template: string }
  | { kind: 'missing-token'; token: string; path: string }
  | { kind: 'io-error'; cause: unknown };

export interface ScaffoldOptions {
  template: TemplateId;
  outDir: string;
  tokens: Record<string, string>;
  force?: boolean;
}

function templatesRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ is one level below package root; templates/ is a sibling of src/
  return join(here, '..', 'templates');
}

function applyTokens(content: string, tokens: Record<string, string>): string {
  let result = content;
  for (const [key, value] of Object.entries(tokens)) {
    result = result.replaceAll('{{' + key + '}}', value);
  }
  return result;
}

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

export async function scaffoldFlow(
  options: ScaffoldOptions,
): Promise<Result<ScaffoldReport, ScaffoldError>> {
  const { template, outDir, tokens, force = false } = options;

  const templateDir = join(templatesRoot(), template);

  // Verify template exists and is a directory
  let st: Stats;
  try {
    st = await stat(templateDir);
  } catch {
    return err({ kind: 'template-not-found', template });
  }
  if (!st.isDirectory()) return err({ kind: 'template-not-found', template });

  // Collect all files under the template directory
  let allFiles: string[];
  try {
    allFiles = await walkDir(templateDir);
  } catch (cause) {
    return err({ kind: 'io-error', cause });
  }

  // Filter out .gitkeep files
  const srcFiles = allFiles.filter((f) => !f.endsWith('.gitkeep'));

  // Build a plan: src -> dest pairs
  const plan: Array<{ src: string; dest: string; relPath: string }> = srcFiles.map((src) => {
    const relPath = relative(templateDir, src);
    return { src, dest: join(outDir, relPath), relPath };
  });

  // Check for collisions before writing anything
  if (!force) {
    for (const { dest } of plan) {
      let exists = false;
      try {
        await stat(dest);
        exists = true;
      } catch {
        // file does not exist — proceed
      }
      if (exists) {
        return err({ kind: 'file-exists', path: dest });
      }
    }
  }

  // Write all files
  const filesWritten: string[] = [];

  for (const { src: srcPath, dest: destPath, relPath } of plan) {
    let content: string;
    try {
      content = await readFile(srcPath, { encoding: 'utf8' });
    } catch (cause) {
      return err({ kind: 'io-error', cause });
    }

    const substituted = applyTokens(content, tokens);

    // Detect unresolved tokens in non-prompt files
    const isPromptFile = relPath.startsWith('prompts/') || relPath.startsWith('prompts\\');
    if (!isPromptFile) {
      const leftover = substituted.match(/\{\{[a-zA-Z_][\w[\]]*\}\}/);
      if (leftover) {
        return err({ kind: 'missing-token', token: leftover[0], path: srcPath });
      }
    }

    try {
      await mkdir(dirname(destPath), { recursive: true });
      await writeFile(destPath, substituted, { encoding: 'utf8' });
    } catch (cause) {
      return err({ kind: 'io-error', cause });
    }

    filesWritten.push(destPath);
  }

  return ok({ filesWritten });
}

export function pickTemplate(intentText: string): TemplateId {
  const lower = intentText.toLowerCase();
  if (/(explore|audit|document|review codebase)/.test(lower)) return 'discovery';
  if (/(then|chain|sequential)/.test(lower)) return 'linear';
  if (/(parallel|fan[-_ ]?out)/.test(lower)) return 'fan-out';
  return 'blank';
}
