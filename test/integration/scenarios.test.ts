// Scenario tests inside VS Code (AFD-58): Run Scenarios runs a flow's scenarios file in the run
// environment. With AFD_TEST_IMAGE (an Ansible image) the scenarios run for real.
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
        // AFD-84: each result keeps its run, so the designer can show it on the canvas.
        for (const r of results ?? []) assert.ok(r.summary?.hosts.length, r.name);
        // AFD-105: and what the scenario forced, so a planted failure can say so.
        assert.deepEqual(results?.[2]?.forced, [
          { host: 'h02', step: 'stage/prepare', outcome: 'failed', port: 'failed_hosts' },
          { host: 'h03', step: 'gate', outcome: 'failed', port: 'failed_hosts' },
        ]);
        assert.equal(results?.[0]?.forced, undefined);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
