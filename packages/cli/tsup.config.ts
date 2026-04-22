import { defineConfig } from 'tsup';

// cli.ts uses a dynamic import() with a template literal to load commands at
// runtime (`import(\`./commands/${name}.js\`)`). tsup's bundler transforms this
// into an empty __glob({}) map, which fails at runtime.
//
// The fix: transpile all CLI source files without bundling them (bundle: false).
// Each file is emitted as its own .js in dist/ mirroring the src/ layout.
// Node.js resolves the dynamic import() natively against the emitted files.
// The commands are listed as separate entries so they appear in dist/commands/.

export default defineConfig({
  entry: [
    'src/cli.ts',
    'src/banner.ts',
    'src/dispatcher.ts',
    'src/exit-codes.ts',
    'src/flow-loader.ts',
    'src/input-parser.ts',
    'src/lint.ts',
    'src/progress.ts',
    'src/registry.ts',
    'src/telemetry.ts',
    'src/visual.ts',
    'src/commands/doctor.ts',
    'src/commands/init.ts',
    'src/commands/install.ts',
    'src/commands/list.ts',
    'src/commands/new.ts',
    'src/commands/publish.ts',
    'src/commands/resume.ts',
    'src/commands/run.ts',
    'src/commands/runs.ts',
    'src/commands/search.ts',
    'src/commands/test.ts',
    'src/commands/upgrade.ts',
  ],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  shims: false,
  bundle: false,
  outDir: 'dist',
});
