// Bundles the CLI + worker into a single committed file, so the plugin runs without `npm install`.
import { build } from 'esbuild';

await build({
  entryPoints: ['bin/eonix-mem.ts'],
  outfile: 'dist/eonix-mem.cjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  // node:sqlite is built into Node >= 22.5: keep it external.
  external: ['node:sqlite'],
});
