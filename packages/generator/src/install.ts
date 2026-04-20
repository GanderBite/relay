import { copyFile, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from 'neverthrow';

export interface InstallReport {
  destDir: string;
  filesWritten: number;
}

export type InstallError = { kind: 'io-error'; cause: unknown };

function packageRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/ is one level below package root
  return join(here, '..');
}

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

async function copyTree(srcDir: string, destDir: string): Promise<number> {
  let count = 0;
  let files: string[];
  try {
    files = await walkDir(srcDir);
  } catch {
    // source dir absent — skip gracefully
    return 0;
  }

  const filtered = files.filter((f) => !f.endsWith('.gitkeep'));

  for (const srcPath of filtered) {
    const rel = relative(srcDir, srcPath);
    const destPath = join(destDir, rel);
    await mkdir(dirname(destPath), { recursive: true });
    await copyFile(srcPath, destPath);
    count += 1;
  }

  return count;
}

export async function installGenerator(
  destRoot?: string,
): Promise<Result<InstallReport, InstallError>> {
  const destDir = destRoot ?? join(os.homedir(), '.claude', 'skills', 'relay-generator');
  const pkgRoot = packageRoot();

  try {
    await mkdir(destDir, { recursive: true });

    let filesWritten = 0;

    // Copy SKILL.md
    const skillSrc = join(pkgRoot, 'skill', 'SKILL.md');
    const skillDest = join(destDir, 'SKILL.md');
    await mkdir(dirname(skillDest), { recursive: true });
    await copyFile(skillSrc, skillDest);
    filesWritten += 1;

    // Copy templates/ tree (skip .gitkeep)
    filesWritten += await copyTree(join(pkgRoot, 'templates'), join(destDir, 'templates'));

    // Copy dist/ tree only if it exists (skip gracefully when not built)
    const distSrc = join(pkgRoot, 'dist');
    let distExists = false;
    try {
      await stat(distSrc);
      distExists = true;
    } catch {
      // dist not built yet — will be noted by the caller
    }
    if (distExists) {
      filesWritten += await copyTree(distSrc, join(destDir, 'dist'));
    }

    return ok({ destDir, filesWritten });
  } catch (cause) {
    return err({ kind: 'io-error', cause });
  }
}
