// Scenario tests on the command line (AFD-58), for CI: runs every flow's `<key>.scenarios.yaml` and
// exits 1 when one fails. Shipped as dist/afd-scenarios.js; Ansible Flow: Copy Scenario Runner puts
// it into the repository. A run needs Docker or Podman with an EE image (--image), or
// ansible-playbook and sh on this machine (--python, the default). AFD-114: --simulate computes
// where hosts go without Ansible, --check only checks the files. `--help` lists the options.
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import callback from '../../probe/callback_plugins/afd_events.py';
import type { Environment } from '../core/run/environment';
import { blocking, type ScenarioResult } from '../core/scenario/scenarios';
import {
  loadScenarioFlows,
  NO_SCENARIOS,
  parseCliArgs,
  problemLines,
  simulateFlow,
  USAGE,
} from '../node/scenario/cli';
import { describeResults, failedCount, junitXml, runScenarios } from '../node/scenario/runner';

const o = parseCliArgs(process.argv.slice(2));
if (o.help || o.error || o.targets.length === 0) {
  if (o.error) console.log(o.error);
  console.log(USAGE);
  process.exit(o.help && !o.error ? 0 : 2);
}

if (o.wsl !== undefined && process.platform !== 'win32') {
  console.log(
    '--wsl runs WSL from Windows; here, run without it (ansible-playbook on this machine)',
  );
  process.exit(2);
}
const env: Environment =
  o.wsl !== undefined
    ? {
        kind: 'wsl',
        distro: o.wsl || undefined,
        python: o.python,
        label: `wsl: ${o.wsl || 'the default distribution'}`,
      }
    : o.image
      ? {
          kind: 'container',
          engine: o.engine ?? 'docker',
          image: o.image,
          options: [],
          mounts: [],
          source: 'afd',
          label: o.image,
        }
      : { kind: 'local', python: o.python ?? 'python3', source: 'afd', label: 'local' };

/** The routing callback the designer runs with, written where Ansible can load it. */
function probe(): string {
  const dir = mkdtempSync(join(tmpdir(), 'afd-scenarios-'));
  mkdirSync(join(dir, 'callback_plugins'));
  writeFileSync(join(dir, 'callback_plugins', 'afd_events.py'), callback);
  // mkdtemp makes it private; the image's own user must read the callback.
  chmodSync(dir, 0o755);
  chmodSync(join(dir, 'callback_plugins'), 0o755);
  return dir;
}

// esbuild writes CommonJS, which has no top-level await.
async function main(): Promise<number> {
  const flows = loadScenarioFlows(o.targets);
  if (flows.length === 0) {
    console.log(NO_SCENARIOS);
    return 0;
  }
  const probeDir = o.check || o.simulate ? '' : probe();
  const junit: string[] = [];
  let failed = 0;
  for (const f of flows) {
    for (const line of problemLines(f)) console.log(line);
    if (!f.file || blocking(f.problems).length > 0) {
      failed++;
      continue;
    }
    const count = `${f.file.scenarios.length} scenario(s)`;
    if (o.check) {
      console.log(`${f.doc.flow.key}: ${count} fit the flow`);
      continue;
    }
    console.log(`${f.doc.flow.key}: ${count} ${o.simulate ? 'simulated' : `in ${env.label}`}`);
    const results: ScenarioResult[] = o.simulate
      ? simulateFlow(f, o.only)
      : await runScenarios({
          env,
          root: process.cwd(),
          probeDir,
          flowFile: resolve(f.flowFile),
          doc: f.doc,
          file: f.file,
          workDir: join(probeDir, 'runs'),
          only: o.only,
          keep: o.keep,
          log: o.verbose ? (line) => console.log(`  | ${line}`) : undefined,
        });
    for (const line of describeResults(results, f.doc)) console.log(line);
    failed += failedCount(results);
    junit.push(junitXml(f.doc.flow.key, results, f.doc));
  }
  if (o.junit) writeFileSync(o.junit, junit.join('\n'));
  return failed > 0 ? 1 : 0;
}

void main().then((code) => process.exit(code));
