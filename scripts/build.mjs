// Builds the extension host bundle (esbuild) and the webview bundle (Vite).
// Flags: --production (minify, no sourcemaps), --watch, --tests (integration test bundles only).
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testsOnly = process.argv.includes('--tests');

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  entryPoints: ['src/extension/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development') },
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const testOptions = {
  entryPoints: readdirSync('test/integration')
    .filter((f) => f.endsWith('.test.ts'))
    .map((f) => join('test/integration', f)),
  outdir: 'out/test/integration',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode', 'mocha'],
  sourcemap: true,
  logLevel: 'info',
};

async function buildWebview() {
  await viteBuild({
    configFile: 'vite.config.mts',
    mode: production ? 'production' : 'development',
    build: watch ? { watch: {} } : {},
    logLevel: 'warn',
  });
}

if (testsOnly) {
  await esbuild.build(testOptions);
} else if (watch) {
  const ctx = await esbuild.context(hostOptions);
  await ctx.watch();
  await buildWebview();
} else {
  await esbuild.build(hostOptions);
  await buildWebview();
}
