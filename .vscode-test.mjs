import { execFileSync } from 'node:child_process';
import { copyFileSync, cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig } from '@vscode/test-cli';

const version = process.env.AFD_VSCODE_VERSION ?? 'stable';

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
if (process.env.AFD_TEST_IMAGE) {
  mkdirSync(join(workspace, '.vscode'), { recursive: true });
  writeFileSync(
    join(workspace, '.vscode', 'settings.json'),
    JSON.stringify({ 'afd.environment.image': process.env.AFD_TEST_IMAGE }, null, 2),
  );
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
  launchArgs: ['--disable-extensions', '--disable-workspace-trust'],
  mocha: { ui: 'bdd', timeout: 60_000 },
};

export default defineConfig([
  {
    ...common,
    label: 'integration',
    files: ['out/test/integration/editor.test.js', 'out/test/integration/codegen.test.js'],
  },
  { ...common, label: 'm3', files: 'out/test/integration/codegen.test.js' },
  { ...common, label: 'perf', files: 'out/test/integration/perf.test.js' },
]);
