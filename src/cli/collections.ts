// Development CLI (not shipped, AFD-274): the collections flows need, as a requirements.yml for
// `ansible-galaxy collection install -r`. The repository's collections/requirements.yml, when
// given, wins; a step made against a version it does not allow is reported on stderr.
// Usage: collections [--requirements collections/requirements.yml] <flow.yaml>...
import { readFileSync } from 'node:fs';
import {
  type FlowCollection,
  flowCollections,
  mergeRequirements,
  requirementsYaml,
} from '../core/flow/collections';
import { parseFlow } from '../core/flow/document';
import { parseRequirements } from '../core/lens/requirements';

const args = process.argv.slice(2);
const at = args.indexOf('--requirements');
const pinsFile = at >= 0 ? args[at + 1] : undefined;
const flows = args.filter((a, i) => !a.startsWith('--') && (at < 0 || i !== at + 1));
if (!flows.length) {
  console.error('Usage: collections [--requirements collections/requirements.yml] <flow.yaml>...');
  process.exit(2);
}

// Several flows: one list, every step and version of each.
const all = new Map<string, FlowCollection>();
for (const file of flows) {
  const parsed = parseFlow(readFileSync(file, 'utf8'));
  if (!parsed.doc) {
    console.error(`${file}: ${parsed.errors[0]?.message ?? 'not a flow'}`);
    process.exitCode = 1;
    continue;
  }
  for (const c of flowCollections(parsed.doc)) {
    const before = all.get(c.name);
    all.set(c.name, {
      name: c.name,
      versions: [...new Set([...(before?.versions ?? []), ...c.versions])],
      nodes: [...new Set([...(before?.nodes ?? []), ...c.nodes])],
    });
  }
}
const pins = pinsFile ? parseRequirements(readFileSync(pinsFile, 'utf8')) : {};
const needed = mergeRequirements([...all.values()], pins);
for (const r of needed) if (r.conflict) console.error(`warning: ${r.conflict}`);
process.stdout.write(requirementsYaml(needed));
