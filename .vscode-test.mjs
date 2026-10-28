import { defineConfig } from '@vscode/test-cli';

const version = process.env.AFD_VSCODE_VERSION ?? 'stable';

export default defineConfig([
  {
    label: 'integration',
    files: 'out/test/integration/*.test.js',
    version,
    launchArgs: ['--disable-extensions'],
    mocha: { ui: 'bdd', timeout: 60_000 },
  },
]);
