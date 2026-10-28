import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
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
  { ...common, label: 'integration', files: 'out/test/integration/editor.test.js' },
  { ...common, label: 'perf', files: 'out/test/integration/perf.test.js' },
]);
