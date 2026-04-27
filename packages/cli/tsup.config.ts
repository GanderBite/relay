import { defineConfig } from 'tsup';

// dispatcher.ts uses static () => import('./commands/X.js') entries so esbuild
// can analyze each path and emit them as lazy split-chunks. This replaces the
// previous bundle: false approach (which required transpiling every source file
// individually to preserve template-literal dynamic imports).
//
// relay-core is inlined (noExternal) to eliminate the external npm dependency.
// Its CJS dependencies — pino, pino-pretty, handlebars — are kept external so
// Node.js loads them natively, avoiding the ESM-in-CJS dynamic-require issue
// (esbuild cannot inject a createRequire shim into a shared split-chunk).
// Those packages are declared directly in CLI's dependencies.

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
  external: ['pino', 'pino-pretty', 'handlebars'],
  outDir: 'dist',
});
