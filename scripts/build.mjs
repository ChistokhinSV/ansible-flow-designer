// Builds the extension host bundle (esbuild) and the webview bundle (Vite).
// Flags: --production (minify, no sourcemaps), --watch, --tests (integration test bundles only).
import { cpSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as esbuild from 'esbuild';
import { build as viteBuild } from 'vite';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');
const testsOnly = process.argv.includes('--tests');
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
// The MCP server for terminal agents (AFD-19) starts per agent session: keep it small. AFD-27 raised
// it from 900 KB for the import tools (the reader and mappers, about 60 KB; a lazy chunk would carry
// its own copy of yaml and the flow model).
const MCP_BUDGET = 960 * 1024;

/**
 * ELK is most of the host code: the extension loads it on first use (autoLayout.ts), from its
 * own file dist/elk.js, so activation and the debugger's source maps skip it.
 * @type {import('esbuild').Plugin}
 */
const elkApart = {
  name: 'elk-apart',
  setup(build) {
    build.onResolve({ filter: /^elkjs\/lib\/elk\.bundled\.js$/ }, (args) =>
      args.kind === 'dynamic-import' ? { path: './elk.js', external: true } : undefined,
    );
  },
};

/**
 * Exports route wires with React Flow's getSmoothStepPath from @xyflow/system (AFD-25). That
 * package also imports d3's zoom and drag, which declare side effects and so stay in a bundle
 * unused (about 40 KB). The host and the MCP server never pan or drag: d3 is an empty module there.
 * @type {import('esbuild').Plugin}
 */
const noD3 = {
  name: 'no-d3',
  setup(build) {
    build.onResolve({ filter: /^d3-/ }, (args) => ({ path: args.path, namespace: 'no-d3' }));
    build.onLoad({ filter: /.*/, namespace: 'no-d3' }, () => ({
      contents: 'module.exports = {};',
      loader: 'js',
    }));
  },
};

/** @type {import('esbuild').BuildOptions} */
const hostOptions = {
  // The catalog index is built in a worker thread (node:sqlite is synchronous, M5).
  entryPoints: {
    extension: 'src/extension/extension.ts',
    catalogWorker: 'src/extension/catalog/catalogWorker.ts',
    elk: 'elkjs/lib/elk.bundled.js',
    mcp: 'src/mcp/main.ts',
  },
  plugins: [elkApart, noD3],
  // jsonc-parser's default (UMD) build requires its parts at run time; the ESM build bundles.
  alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' },
  outdir: 'dist',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  legalComments: 'none',
  define: {
    'process.env.NODE_ENV': JSON.stringify(production ? 'production' : 'development'),
    __AFD_VERSION__: JSON.stringify(version),
  },
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
  const mcp = statSync('dist/mcp.js').size;
  if (production && mcp > MCP_BUDGET)
    throw new Error(
      `dist/mcp.js is ${Math.round(mcp / 1024)} KB, over the ${MCP_BUDGET / 1024} KB budget`,
    );
  await buildWebview();
}
