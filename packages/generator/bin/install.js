#!/usr/bin/env node
import('../dist/install.js')
  .then(async (mod) => {
    const result = await mod.installGenerator();
    if (result.isErr()) {
      const cause = result.error.cause;
      const msg = cause instanceof Error ? cause.message : String(cause);
      process.stderr.write(`\u2715 install failed: ${msg}\n`);
      process.exit(1);
    }
    const { destDir, filesWritten } = result.value;
    process.stdout.write(`\u2713 relay-generator installed\n  \u00b7 path: ${destDir}\n`);
    process.stdout.write(`  · ${filesWritten} file(s) written\n`);
    process.stdout.write(`  · restart Claude Code if it is already running to pick up the new skill\n`);
  })
  .catch((err) => {
    console.error(err?.stack ?? err);
    process.exit(1);
  });
