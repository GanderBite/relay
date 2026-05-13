import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// dispatcher.ts uses static () => import('./commands/X.js') entries so esbuild
// can analyze each path and emit them as lazy split-chunks. This replaces the
// previous bundle: false approach (which required transpiling every source file
// individually to preserve template-literal dynamic imports).
//
// relay-core is inlined (noExternal) to eliminate the external npm dependency.
// Its CJS dependencies — pino, pino-pretty, handlebars, gray-matter — are kept
// external so Node.js loads them natively, avoiding the ESM-in-CJS dynamic-require
// issue (esbuild cannot inject a createRequire shim into a shared split-chunk).
// Those packages are declared directly in CLI's dependencies.

const corePkgPath = fileURLToPath(new URL('../core/package.json', import.meta.url));
const corePkg = JSON.parse(readFileSync(corePkgPath, 'utf8')) as { version: string };

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  splitting: true,
  bundle: true,
  noExternal: ['@ganderbite/relay-core'],
  external: ['pino', 'pino-pretty', 'handlebars', 'gray-matter'],
  outDir: 'dist',
  // The bundled relay-core version, embedded at build time so `relay --version`
  // can report what's actually inlined rather than reusing the CLI version.
  define: {
    __RELAY_CORE_VERSION__: JSON.stringify(corePkg.version),
  },
});
