// The scenario command line (AFD-58, AFD-114), apart from its entry file so it can be tested:
// arguments, the flows with scenarios under the paths named, and the two modes that need no Ansible,
// --check (the files against their flows) and --simulate (where each host goes, computed).
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseFlow } from '../../core/flow/document';
import { isFileKey } from '../../core/flow/ids';
import type { FlowDocument } from '../../core/flow/types';
import {
  checkScenarios,
  parseScenarios,
  type ScenarioFile,
  type ScenarioProblem,
  scenariosFileName,
} from '../../core/scenario/scenarios';
import { simulateScenario } from '../../core/scenario/simulate';

export const USAGE = [
  'Usage: node afd-scenarios.js [options] <flow.yaml|folder>...',
  '',
  'Runs the scenarios in <flow key>.scenarios.yaml next to each flow; exits 1 when one fails.',
  '',
  '  --simulate           compute where each host goes, without Ansible (instant); a scenario',
  '                       the simulator cannot model is skipped: verify it with a run',
  '  --check              only check the scenario files against their flows',
  '  --image IMAGE        run in this execution environment image (Docker or Podman)',
  '  --engine docker|podman',
  '  --python PATH        run with ansible-playbook on this machine (default: python3)',
  '  --wsl                run in WSL from Windows (the default distribution)',
  '  --wsl-distro NAME    run in this WSL distribution',
  '  --scenario NAME      run only this scenario (repeatable)',
  '  --junit FILE         write JUnit XML for CI dashboards',
  '  --keep               keep each run folder',
  '  --verbose            print Ansible output',
].join('\n');

export interface CliOptions {
  targets: string[];
  image?: string;
  engine?: 'docker' | 'podman';
  python?: string;
  junit?: string;
  /** AFD-118: run in WSL from Windows; the distribution, or '' for the default one. */
  wsl?: string;
  only?: string[];
  keep: boolean;
  verbose: boolean;
  simulate: boolean;
  check: boolean;
  help: boolean;
  /** An option this command does not know, or one without its value. */
  error?: string;
}

const WITH_VALUE = new Set([
  '--image',
  '--engine',
  '--python',
  '--junit',
  '--scenario',
  '--wsl-distro',
]);
const SWITCHES = new Set(['--keep', '--verbose', '--simulate', '--check', '--help', '--wsl']);

export function parseCliArgs(args: readonly string[]): CliOptions {
  const o: CliOptions = {
    targets: [],
    keep: false,
    verbose: false,
    simulate: false,
    check: false,
    help: false,
  };
  const only: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (WITH_VALUE.has(a)) {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) o.error ??= `${a} needs a value`;
      else if (a === '--image') o.image = v;
      else if (a === '--engine') {
        if (v === 'docker' || v === 'podman') o.engine = v;
        else o.error ??= `--engine takes docker or podman, not ${v}`;
      } else if (a === '--python') o.python = v;
      else if (a === '--junit') o.junit = v;
      else if (a === '--wsl-distro') o.wsl = v;
      else only.push(v);
    } else if (SWITCHES.has(a)) {
      if (a === '--keep') o.keep = true;
      if (a === '--verbose') o.verbose = true;
      if (a === '--simulate') o.simulate = true;
      if (a === '--check') o.check = true;
      if (a === '--help') o.help = true;
      if (a === '--wsl') o.wsl ??= '';
    } else if (a.startsWith('--')) o.error ??= `Unknown option ${a}`;
    else o.targets.push(a);
  }
  if (only.length) o.only = only;
  if (o.simulate && o.check) o.error ??= 'Give --simulate or --check, not both';
  if (o.wsl !== undefined && o.image) o.error ??= 'Give --wsl or --image, not both';
  return o;
}

/** Flow files: the ones named, and every *.flow.yaml under the folders named. */
export function flowsOf(target: string): string[] {
  if (!statSync(target).isDirectory()) return [target];
  return readdirSync(target, { recursive: true, encoding: 'utf8' })
    .filter((f) => f.endsWith('.flow.yaml') && !f.includes('node_modules'))
    .map((f) => join(target, f));
}

export interface FlowScenarios {
  flowFile: string;
  scenariosFile: string;
  doc: FlowDocument;
  file?: ScenarioFile;
  /** The file does not read as scenarios. */
  error?: string;
  problems: ScenarioProblem[];
}

/** The flows under the targets that have a scenarios file, read and checked. */
export function loadScenarioFlows(targets: readonly string[]): FlowScenarios[] {
  const out: FlowScenarios[] = [];
  for (const flowFile of targets.flatMap(flowsOf)) {
    // AFD-147: a flow that does not read (an alias inside what it names, too) has no scenarios.
    const doc = parseFlow(readFileSync(flowFile, 'utf8')).doc;
    if (!doc) continue;
    // AFD-133: a key that cannot name a file names no scenarios file either.
    if (!isFileKey(doc?.flow?.key)) continue;
    const scenariosFile = join(dirname(flowFile), scenariosFileName(doc.flow.key));
    if (!existsSync(scenariosFile)) continue;
    // AFD-159: a scenarios file that does not read or check fails alone, as a FAIL line.
    try {
      const parsed = parseScenarios(readFileSync(scenariosFile, 'utf8'));
      out.push({
        flowFile,
        scenariosFile,
        doc,
        file: parsed.file,
        error: parsed.error,
        problems: parsed.file ? checkScenarios(doc, parsed.file) : [],
      });
    } catch (e) {
      out.push({ flowFile, scenariosFile, doc, error: (e as Error).message, problems: [] });
    }
  }
  return out;
}

/** One line per problem: FAIL for errors, WARN for warnings (they do not stop a run). */
export function problemLines(f: FlowScenarios): string[] {
  if (f.error) return [`FAIL ${f.scenariosFile}: ${f.error}`];
  return f.problems.map((p) => {
    const where = p.scenario >= 0 ? ` [${f.file?.scenarios[p.scenario]?.name ?? p.scenario}]` : '';
    return `${p.severity === 'warning' ? 'WARN' : 'FAIL'} ${f.scenariosFile}${where}: ${p.message}`;
  });
}

/** The scenarios of one flow, computed by the simulator. */
export function simulateFlow(f: FlowScenarios, only?: readonly string[]) {
  return (f.file?.scenarios ?? [])
    .filter((s) => !only || only.includes(s.name))
    .map((s) => simulateScenario(f.doc, s));
}

export const NO_SCENARIOS =
  'No scenarios found: a flow has them in <flow key>.scenarios.yaml next to its .flow.yaml';
