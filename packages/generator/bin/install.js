#!/usr/bin/env node
import('../dist/install.js').then((mod) => {
  return mod.install();
}).catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(1);
});
