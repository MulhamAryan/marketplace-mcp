// Bundles the CLI + worker into a single committed file, so the plugin runs without `npm install`.
// ESM output: the Claude Agent SDK is ESM-only (import.meta.url). The banner gives bundled
// CommonJS dependencies (Express) a working `require`.
import { build } from 'esbuild';

await build({
  entryPoints: ['bin/eonix-mem.ts'],
  outfile: 'dist/eonix-mem.mjs',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
  banner: {
    js: "import { createRequire as __eonixCreateRequire } from 'node:module'; const require = __eonixCreateRequire(import.meta.url);",
  },
  external: [
    // Built into Node >= 22.5.
    'node:sqlite',
    // The SDK's ~330 MB per-platform native Claude Code binaries: never bundled, we drive the
    // developer's installed `claude` through pathToClaudeCodeExecutable instead.
    '@anthropic-ai/claude-agent-sdk-*',
  ],
});
