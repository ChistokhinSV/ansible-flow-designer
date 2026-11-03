// Bundles the usability kit (AFD-78) with the repository's own core into out/usability/kit.cjs,
// with the esbuild options the host bundle uses (scripts/build.mjs).
import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['scripts/usability/kit.ts'],
  outfile: 'out/usability/kit.cjs',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  loader: { '.py': 'text', '.html': 'text' },
  // jsonc-parser's default (UMD) build requires its parts at run time; the ESM build bundles.
  alias: { 'jsonc-parser': './node_modules/jsonc-parser/lib/esm/main.js' },
  external: ['vscode'],
  logLevel: 'warning',
});
