import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const version = process.env.AFD_VSCODE_VERSION ?? 'stable';

// M7: the lab AWX for the `m7` suite (AFD_AWX_URL, AFD_AWX_TOKEN, AFD_AWX_GIT_REMOTE,
// AFD_AWX_GIT_SSH) may come from the gitignored .env; nothing else is read from it.
if (existsSync('.env'))
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(AFD_AWX_[A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }

// A fresh Git repository with the examples as committed flows, so tests can edit and save freely
// and the version bump can be checked against HEAD (ADR-0006).
const workspace = resolve('out/test-workspace');
rmSync(workspace, { recursive: true, force: true });
for (const key of ['edge-baseline', 'os-upgrade']) {
  mkdirSync(join(workspace, 'flows', key), { recursive: true });
  copyFileSync(
    join('examples', `${key}.flow.yaml`),
    join(workspace, 'flows', key, `${key}.flow.yaml`),
  );
}
// M3: an Ansible repository around the flows (fictional inventory, stub roles), and the Docker
// image for runs when AFD_TEST_IMAGE is set (run tests are skipped without it).
cpSync('test/fixtures/engine/content', workspace, { recursive: true });
// M6: a repository with drift (mockup 04): its flow, roles and playbook.
for (const dir of ['flows', 'roles', 'playbooks'])
  cpSync(join('test/fixtures/drift', dir), join(workspace, dir), { recursive: true });
// M7: the flow the lab AWX runs (its generated code is committed, as AWX needs it).
cpSync('test/fixtures/awx/repo/flows', join(workspace, 'flows'), { recursive: true });
// M8: the lens fixture flow and the requirements pins. Its inventory (with a vaulted variable) is
// copied by the lens test itself: in the workspace from the start, the vault check of the M3 runs
// (which scans the repository) would make them ask for a vault password.
cpSync('test/fixtures/lens/flows', join(workspace, 'flows'), { recursive: true });
cpSync('test/fixtures/lens/collections', join(workspace, 'collections'), { recursive: true });
writeFileSync(
  join(workspace, 'ansible.cfg'),
  [
    '[defaults]',
    'inventory = inventory.ini',
    'roles_path = roles',
    'collections_path = collections:~/.ansible/collections:/usr/share/ansible/collections',
    'host_key_checking = False',
    '',
  ].join('\n'),
);
const settings = {
  ...(process.env.AFD_TEST_IMAGE ? { 'afd.environment.image': process.env.AFD_TEST_IMAGE } : {}),
  ...(process.env.AFD_AWX_URL ? { 'afd.awx.url': process.env.AFD_AWX_URL } : {}),
};
if (Object.keys(settings).length > 0) {
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(join(workspace, '.vscode', 'settings.json'), JSON.stringify(settings, null, 2));
}
const git = (...args) => execFileSync('git', args, { cwd: workspace, stdio: 'ignore' });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'AFD Test');
git('config', 'user.email', 'afd-test@example.net');
git('config', 'core.autocrlf', 'false');
git('add', '-A');
git('commit', '-q', '-m', 'fixtures');

const common = {
  version,
  workspaceFolder: workspace,
  launchArgs: [
    '--disable-extensions',
    '--disable-workspace-trust',
    // Electron as root in the lab's throwaway container (lab/ci-in-container.sh).
    ...(process.env.AFD_TEST_NO_SANDBOX ? ['--no-sandbox', '--disable-gpu'] : []),
  ],
  mocha: { ui: 'bdd', timeout: 60_000 },
};

export default defineConfig([
  {
    ...common,
    label: 'integration',
    files: [
      'out/test/integration/editor.test.js',
      'out/test/integration/codegen.test.js',
      'out/test/integration/subflow.test.js',
      'out/test/integration/catalog.test.js',
      'out/test/integration/drift.test.js',
      'out/test/integration/lens.test.js',
      'out/test/integration/awxImport.test.js',
      'out/test/integration/extract.test.js',
      'out/test/integration/notAFlow.test.js',
      'out/test/integration/clipboard.test.js',
      'out/test/integration/edit.test.js',
      'out/test/integration/ai.test.js',
    ],
  },
  { ...common, label: 'm3', files: 'out/test/integration/codegen.test.js' },
  { ...common, label: 'm4', files: 'out/test/integration/subflow.test.js' },
  { ...common, label: 'm5', files: 'out/test/integration/catalog.test.js' },
  { ...common, label: 'm6', files: 'out/test/integration/drift.test.js' },
  // M7: the lab AWX (skipped without AFD_AWX_URL and AFD_AWX_TOKEN).
  {
    ...common,
    label: 'm7',
    // AFD-11: the AWX workflow with an approval runs after the M7 job tests.
    files: ['out/test/integration/awx.test.js', 'out/test/integration/awxWorkflow.test.js'],
  },
  { ...common, label: 'm8', files: 'out/test/integration/lens.test.js' },
  // M9: import from the export fixture; the skeleton run needs AFD_TEST_IMAGE, the API import the lab AWX.
  { ...common, label: 'm9', files: 'out/test/integration/awxImport.test.js' },
  // AFD-7: extract a selection into a subflow.
  { ...common, label: 'extract', files: 'out/test/integration/extract.test.js' },
  // AFD-16: an empty or broken *.flow.yaml.
  { ...common, label: 'not-a-flow', files: 'out/test/integration/notAFlow.test.js' },
  // AFD-17: copy and paste of nodes through the system clipboard.
  { ...common, label: 'clipboard', files: 'out/test/integration/clipboard.test.js' },
  // AFD-18: one undo step per selection edit.
  { ...common, label: 'edit', files: 'out/test/integration/edit.test.js' },
  // AFD-19: AI assistants (Complete IDs, Copilot tools, setup, MCP on VS Code's runtime).
  { ...common, label: 'ai', files: 'out/test/integration/ai.test.js' },
  { ...common, label: 'perf', files: 'out/test/integration/perf.test.js' },
  // AFD-5: with the Red Hat YAML extension (so no --disable-extensions); opt-in, needs the network.
  {
    ...common,
    label: 'yaml',
    files: 'out/test/integration/yaml.test.js',
    launchArgs: ['--disable-workspace-trust'],
    installExtensions: ['redhat.vscode-yaml@2.0.0'],
  },
]);
