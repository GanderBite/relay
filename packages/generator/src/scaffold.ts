import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
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
  | { kind: 'io-error'; cause: unknown };

export interface ScaffoldOptions {
  template: TemplateId;
  outDir: string;
  tokens: Record<string, string>;
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
  const { template, outDir, tokens } = options;
  const force = tokens['force'] === 'true';

  const templateDir = join(templatesRoot(), template);

  // Verify template exists
  try {
    await stat(templateDir);
  } catch {
    return err({ kind: 'template-not-found', template });
  }

  // Collect all files under the template directory
  let allFiles: string[];
  try {
    allFiles = await walkDir(templateDir);
  } catch (cause) {
    return err({ kind: 'io-error', cause });
  }

  // Filter out .gitkeep files
  const files = allFiles.filter((f) => !f.endsWith('.gitkeep'));

  const filesWritten: string[] = [];

  for (const srcPath of files) {
    const relPath = relative(templateDir, srcPath);
    const destPath = join(outDir, relPath);

    // Check for pre-existing file
    if (!force) {
      let exists = false;
      try {
        await stat(destPath);
        exists = true;
      } catch {
        // file does not exist — proceed
      }
      if (exists) {
        return err({ kind: 'file-exists', path: destPath });
      }
    }

    // Read source, substitute tokens, write to dest
    let content: string;
    try {
      content = await readFile(srcPath, { encoding: 'utf8' });
    } catch (cause) {
      return err({ kind: 'io-error', cause });
    }

    const substituted = applyTokens(content, tokens);

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
  if (/(parallel|fan.out)/.test(lower)) return 'fan-out';
  return 'blank';
}
