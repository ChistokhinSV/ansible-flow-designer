// Regenerates what AI assistants read from the code that defines the flow format (AFD-19): the
// skill's reference files and the Copilot tool entries in package.json. Run with `just gen-ai`;
// a unit test fails while either is stale.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out', 'gen-ai.mjs');
await build({
  stdin: {
    contents:
      "export { referenceFiles } from './src/core/ai/reference';\nexport { languageModelTools } from './src/core/ai/contributions';",
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: out,
  logLevel: 'warning',
});
const { referenceFiles, languageModelTools } = await import(pathToFileURL(out).href);

const refs = join(root, 'skills', 'ansible-flow', 'references');
mkdirSync(refs, { recursive: true });
for (const [name, text] of Object.entries(referenceFiles())) {
  writeFileSync(join(refs, name), text);
  console.log(`wrote skills/ansible-flow/references/${name}`);
}

const pkgPath = join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
pkg.contributes.languageModelTools = languageModelTools();
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('updated package.json contributes.languageModelTools');
