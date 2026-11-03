// Scenario tests inside VS Code (AFD-58): Run Scenarios runs a flow's scenarios file in the run
// environment. With AFD_TEST_IMAGE (the GNS3 VM suites) the scenarios run for real.
import * as assert from 'node:assert/strict';
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import type { ScenarioResult } from '../../src/core/scenario/scenarios';
import { closeAll, runEnvironment, withTimeout } from './helpers';

const image = runEnvironment;
/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');

describe('AFD-58: scenario tests', () => {
  afterEach(closeAll);

  (image ? it : it.skip)(
    `Run Scenarios runs the scenario build in ${image ?? 'AFD_TEST_IMAGE'}; hosts end where expected`,
    async () => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
      const dir = join(root, 'flows', 'routing-levels');
      mkdirSync(dir, { recursive: true });
      for (const f of ['routing-levels.flow.yaml', 'routing-levels.scenarios.yaml'])
        cpSync(join(REPO, 'test/fixtures/engine', f), join(dir, f));
      try {
        const results = await withTimeout(
          Promise.resolve(
            vscode.commands.executeCommand<ScenarioResult[] | undefined>(
              'afd.run.scenarios',
              vscode.Uri.file(join(dir, 'routing-levels.flow.yaml')),
            ),
          ),
          300_000,
          'scenarios',
        );
        assert.deepEqual(
          results?.map((r) => [r.name, r.passed, r.error]),
          [
            ['every host goes through', true, undefined],
            ['hosts as comma-separated text, as an AWX survey answers', true, undefined],
            ['a failed stage is handled, a failed gate stops the host there', true, undefined],
          ],
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
