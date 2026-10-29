// Builds the extension host bundle (esbuild) and the webview bundle (Vite).
// Flags: --production (minify, no sourcemaps), --watch, --tests (integration test bundles only).
import { cpSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testsOnly = process.argv.includes('--tests');

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  // The catalog index is built in a worker thread (node:sqlite is synchronous, M5).
  entryPoints: {
    extension: 'src/extension/extension.ts',
    catalogWorker: 'src/extension/catalog/catalogWorker.ts',
  },
  outdir: 'dist',
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

/** The probe ships inside the VSIX as plain Python sources (ADR-0005): dist/probe/{afd_probe,callback_plugins}. */
function copyProbe() {
  rmSync('dist/probe', { recursive: true, force: true });
  for (const dir of ['afd_probe', 'callback_plugins']) {
    cpSync(join('probe', dir), join('dist/probe', dir), {
      recursive: true,
      filter: (src) => !src.includes('__pycache__') && !src.endsWith('.pyc'),
    });
  }
}

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
  copyProbe();
  const ctx = await esbuild.context(hostOptions);
  await ctx.watch();
  await buildWebview();
} else {
  copyProbe();
  await esbuild.build(hostOptions);
  await buildWebview();
}
