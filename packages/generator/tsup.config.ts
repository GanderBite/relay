import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/install.ts', 'src/scaffold.ts', 'src/cli.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  splitting: false,
  treeshake: true,
});
