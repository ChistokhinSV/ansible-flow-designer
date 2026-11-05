// Scenario tests on the command line (AFD-58), for CI: runs every flow's `<key>.scenarios.yaml` and
// exits 1 when one fails. Shipped as dist/afd-scenarios.js; Ansible Flow: Copy Scenario Runner puts
// it into the repository. Needs Docker or Podman with an EE image (--image), or ansible-playbook
// and sh on this machine (--python, the default).
//   node afd-scenarios.js [--image IMAGE] [--engine docker|podman] [--python PATH]
//                         [--junit FILE] [--keep] [--scenario NAME]... <flow.yaml|folder>...
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import callback from '../../probe/callback_plugins/afd_events.py';
import type { FlowDocument } from '../core/flow/types';
import type { Environment } from '../core/run/environment';
import {
  checkScenarios,
  parseScenarios,
  type ScenarioResult,
  scenariosFileName,
} from '../core/scenario/scenarios';
import { describeResults, junitXml, runScenarios } from '../node/scenario/runner';

const args = process.argv.slice(2);
const value = (flag: string) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const values = (flag: string) =>
  args.flatMap((a, i) => (a === flag && args[i + 1] ? [args[i + 1] as string] : []));
const flagsWithValue = new Set(['--image', '--engine', '--python', '--junit', '--scenario']);
const targets = args.filter(
  (a, i) => !a.startsWith('--') && !flagsWithValue.has(args[i - 1] ?? ''),
);

if (targets.length === 0 || args.includes('--help')) {
  console.log(
    'Usage: node afd-scenarios.js [--image IMAGE] [--engine docker|podman] [--python PATH] [--junit FILE] [--keep] [--scenario NAME]... <flow.yaml|folder>...',
  );
  process.exit(args.includes('--help') ? 0 : 2);
}

const image = value('--image');
const env: Environment = image
  ? {
      kind: 'container',
      engine: (value('--engine') as 'docker' | 'podman' | undefined) ?? 'docker',
      image,
      options: [],
      mounts: [],
      source: 'afd',
      label: image,
    }
  : { kind: 'local', python: value('--python') ?? 'python3', source: 'afd', label: 'local' };

/** Flow files: the ones named, and every *.flow.yaml under the folders named. */
function flowsOf(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.flow.yaml') && !f.includes('node_modules'))
    .map((f) => join(target, f));
}

// The routing callback the designer runs with, written where Ansible can load it.
const probeDir = mkdtempSync(join(tmpdir(), 'afd-scenarios-'));
mkdirSync(join(probeDir, 'callback_plugins'));
writeFileSync(join(probeDir, 'callback_plugins', 'afd_events.py'), callback);
// mkdtemp makes it private; the image's own user must read the callback.
chmodSync(probeDir, 0o755);
chmodSync(join(probeDir, 'callback_plugins'), 0o755);

// esbuild writes CommonJS, which has no top-level await.
async function main(): Promise<number> {
  const root = process.cwd();
  const junit: string[] = [];
  let failed = 0;
  for (const flowFile of targets.flatMap(flowsOf)) {
    const doc = parse(readFileSync(flowFile, 'utf8')) as FlowDocument;
    const file = join(dirname(flowFile), scenariosFileName(doc.flow.key));
    if (!existsSync(file)) continue;
    const parsed = parseScenarios(readFileSync(file, 'utf8'));
    const problems = parsed.file ? checkScenarios(doc, parsed.file) : [];
    if (!parsed.file || problems.length > 0) {
      failed++;
      console.log(`FAIL ${file}: ${parsed.error ?? problems.map((p) => p.message).join('; ')}`);
      continue;
    }
    console.log(`${doc.flow.key}: ${parsed.file.scenarios.length} scenario(s) in ${env.label}`);
    const results: ScenarioResult[] = await runScenarios({
      env,
      root,
      probeDir,
      flowFile: resolve(flowFile),
      doc,
      file: parsed.file,
      workDir: join(probeDir, 'runs'),
      only: values('--scenario').length ? values('--scenario') : undefined,
      keep: args.includes('--keep'),
      log: args.includes('--verbose') ? (line) => console.log(`  | ${line}`) : undefined,
    });
    for (const line of describeResults(results, doc)) console.log(line);
    failed += results.filter((r) => !r.passed).length;
    junit.push(junitXml(doc.flow.key, results, doc));
  }
  const out = value('--junit');
  if (out) writeFileSync(out, junit.join('\n'));
  return failed > 0 ? 1 : 0;
}

void main().then((code) => process.exit(code));
