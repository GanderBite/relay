#!/usr/bin/env node
import('../dist/cli.js').then((mod) => {
  return mod.main(process.argv);
}).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
