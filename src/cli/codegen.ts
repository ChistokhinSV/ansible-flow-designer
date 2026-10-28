// Development CLI around the engine (not shipped): writes generated/ next to each flow, or checks
// that it is up to date. Usage: codegen [--check] [--simulate] [--out DIR] <flow.yaml>...
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse } from 'yaml';
import { optionA } from '../core/engine/optionA';
import type { FlowDocument } from '../core/flow/types';

const args = process.argv.slice(2);
const check = args.includes('--check');
const simulate = args.includes('--simulate');
const outAt = args.indexOf('--out');
const out = outAt >= 0 ? args[outAt + 1] : undefined;
const flows = args.filter((a, i) => !a.startsWith('--') && (outAt < 0 || i !== outAt + 1));

let stale = 0;
for (const file of flows) {
  const text = readFileSync(file, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const result = optionA.generate(parse(text) as FlowDocument, {
    source: basename(file),
    eol,
    simulate,
  });
  for (const f of result.findings) console.log(`${file}: ${f.severity} ${f.code}: ${f.message}`);
  if (!result.ok) {
    process.exitCode = 1;
    continue;
  }
  const dir = out ?? join(dirname(file), 'generated');
  for (const g of result.files) {
    const target = join(dir, g.name);
    const same = existsSync(target) && readFileSync(target, 'utf8') === g.text;
    if (check) {
      if (!same) {
        console.log(`${target}: out of date`);
        stale++;
      }
      continue;
    }
    if (same) continue;
    mkdirSync(dir, { recursive: true });
    writeFileSync(target, g.text);
    console.log(`wrote ${target}`);
  }
  if (out)
    writeFileSync(join(dir, `${basename(file)}.routes.json`), JSON.stringify(result, null, 1));
}
if (stale > 0) process.exitCode = 1;
