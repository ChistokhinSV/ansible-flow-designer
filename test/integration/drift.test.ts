// M6 acceptance inside VS Code: drift actions that write code (role stub with the binding in one
// WorkspaceEdit, argument_specs), and (with AFD_TEST_IMAGE) a real Re-sync from git in Docker:
// Git label, every play matched by ID, the drift of mockup 04, uncommitted changes.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { computeDrift } from '../../src/core/drift/drift';
import type { CodeScan } from '../../src/core/drift/types';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, runEnvironment, testApi } from './helpers';

const DRIFT = flowUri('edge-drift');
const image = runEnvironment;
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri as vscode.Uri;
const at = (path: string) => vscode.Uri.joinPath(root(), path);
const docOf = (text: string) => parse(text) as FlowDocument;
const idOf = (text: string, key: string) =>
  docOf(text).nodes.find((n) => n.key === key)?.id as string;
const fixtureScan = (): CodeScan => ({
  at: new Date().toISOString(),
  environment: 'fixture',
  ...JSON.parse(readFileSync(join(__dirname, '../../../test/fixtures/drift/scan.json'), 'utf8')),
});

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function remove(path: string): Promise<void> {
  if (await exists(at(path)))
    await vscode.workspace.fs.delete(at(path), { recursive: true, useTrash: false });
}

describe('M6 acceptance: implementation mode and drift', () => {
  afterEach(async () => {
    await closeAll();
    await remove('roles/rollback');
    await remove('roles/netops_backup/meta');
    await remove('roles/netops_validate/tasks/extra.yml');
  });

  it('Generate stub writes the role and binds the node in one edit; Write argument_specs from the contract', async () => {
    const doc = await openDesigner(DRIFT);
    const api = await testApi();
    api.useScan(DRIFT, fixtureScan());
    const rollback = idOf(doc.getText(), 'rollback');
    const stub = await api.driftAction(DRIFT, {
      kind: 'generateStub',
      node: rollback,
      role: 'rollback',
    });
    assert.ok(stub.ok, stub.error);
    const main = readFileSync(at('roles/rollback/tasks/main.yml').fsPath, 'utf8');
    assert.ok(main.includes('TODO: Restore the backed-up configuration'), main);
    const specs = parse(readFileSync(at('roles/rollback/meta/argument_specs.yml').fsPath, 'utf8'));
    assert.equal(specs.argument_specs.main.short_description, 'Rollback');
    assert.deepEqual(docOf(doc.getText()).nodes.find((n) => n.id === rollback)?.impl, {
      kind: 'role',
      ref: 'rollback',
    });
    const again = await api.driftAction(DRIFT, {
      kind: 'generateStub',
      node: rollback,
      role: 'rollback',
    });
    assert.equal(again.ok, false, 'an existing role is never overwritten');

    const backup = idOf(doc.getText(), 'backup-config');
    const written = await api.driftAction(DRIFT, { kind: 'writeSpecs', node: backup });
    assert.ok(written.ok, written.error);
    const backupSpecs = parse(
      readFileSync(at('roles/netops_backup/meta/argument_specs.yml').fsPath, 'utf8'),
    );
    assert.equal(backupSpecs.argument_specs.main.short_description, 'Backup config');
    const twice = await api.driftAction(DRIFT, { kind: 'writeSpecs', node: backup });
    assert.equal(twice.ok, false, 'an existing entry point is left alone');
  });

  (image ? it : it.skip)(
    `real Re-sync in ${image ?? 'AFD_TEST_IMAGE'}: Git label, matches by ID, mockup 04 drift`,
    async function () {
      this.timeout(5 * 60_000);
      const doc = await openDesigner(DRIFT);
      const api = await testApi();
      const scan = await api.sync(DRIFT);
      assert.ok(scan, 'a scan');
      assert.equal(
        scan.generated.error,
        undefined,
        `${scan.generated.path}: ${scan.generated.error}`,
      );
      assert.equal(scan.git?.branch, 'main');
      assert.equal(scan.git?.commit?.length, 7);
      assert.ok(scan.git?.when, 'commit time');
      assert.deepEqual(scan.git?.dirty, []);
      const report = computeDrift(docOf(doc.getText()), scan);
      assert.equal(`${report.matched}/${report.matchable}`, '7/7');
      const ids = report.items.filter((i) => i.severity === 'warning').map((i) => i.id);
      for (const id of [
        'output:validation_result',
        'input-required:site',
        'task-file:wait_for_convergence',
        `unbound:${idOf(doc.getText(), 'rollback')}`,
      ])
        assert.ok(ids.includes(id), `${id} in ${JSON.stringify(ids)}`);
      // An uncommitted change in a bound role shows in the label.
      await vscode.workspace.fs.writeFile(
        at('roles/netops_validate/tasks/extra.yml'),
        new TextEncoder().encode('- ansible.builtin.debug: { msg: x }\n'),
      );
      const later = await api.sync(DRIFT);
      assert.ok(
        later?.git?.dirty.includes('roles/netops_validate/tasks/extra.yml'),
        JSON.stringify(later?.git),
      );
    },
  );
});
