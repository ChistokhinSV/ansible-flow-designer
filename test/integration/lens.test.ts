// M8 acceptance inside VS Code (AFD-13): lenses on the lens-e2e fixture. Chips swap and data wires
// are drawn without editing the flow; Mark expected is one edit with the Git author. With
// AFD_TEST_IMAGE the Inventory and Access lenses read the fixture inventory through the probe, and
// the vaulted value never leaves the container.
import * as assert from 'node:assert/strict';
import { cpSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { LensId } from '../../src/core/lens/types';
import type { DomSummary } from '../../src/core/protocol';
import { closeAll, flowUri, openDesigner, runEnvironment, testApi, withTimeout } from './helpers';

const LENS = flowUri('lens-e2e');
/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');
const image = runEnvironment;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function idOf(key: string): Promise<string> {
  const doc = await vscode.workspace.openTextDocument(LENS);
  return (parse(doc.getText()) as FlowDocument).nodes.find((n) => n.key === key)?.id as string;
}

/** Switches the lens and waits until the webview draws it (and `ready` holds). */
async function showLens(
  lens: LensId | null,
  ready: (d: DomSummary) => boolean = () => true,
  ms = 15_000,
): Promise<DomSummary> {
  const api = await testApi();
  api.setLens(LENS, lens);
  const until = Date.now() + ms;
  for (;;) {
    const dom = await api.inspect(LENS);
    if ((dom.lens?.lens ?? null) === lens && ready(dom)) return dom;
    if (Date.now() > until) throw new Error(`lens ${lens}: ${JSON.stringify(dom.lens)}`);
    await pause(200);
  }
}

describe('M8 acceptance: lenses and semantic zoom', () => {
  afterEach(closeAll);

  it('AFD-57: Changes compares with HEAD from Git: an unsaved title edit is chipped as changed', async () => {
    const doc = await openDesigner(LENS);
    const api = await testApi();
    const precheck = await idOf('precheck');
    api.setLens(LENS, 'changes');
    const until = Date.now() + 15_000;
    while (api.lensFacts(LENS).compare?.state !== 'ready') {
      assert.ok(Date.now() < until, JSON.stringify(api.lensFacts(LENS).compare));
      await pause(200);
    }
    const compare = api.lensFacts(LENS).compare;
    assert.equal(compare?.refs[0]?.ref, 'HEAD');
    assert.equal(compare?.base?.flow.key, 'lens-e2e');
    await api.run(LENS, { kind: 'updateNode', id: precheck, patch: { title: 'Pre-checks v2' } });
    const dom = await showLens('changes', (d) => (d.lens?.chips[precheck]?.length ?? 0) > 0);
    assert.deepEqual(dom.lens?.chips[precheck], ['changed: title']);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.isDirty, false);
    await showLens(null);
  });

  it('Data, Code and Timing swap the chips and draw data wires; the flow is not edited', async () => {
    const doc = await openDesigner(LENS);
    const before = doc.getText();
    const [precheck, upgrade, post] = await Promise.all(['precheck', 'upgrade', 'post'].map(idOf));
    const data = await showLens('data', (d) => d.lens?.dataWires === 2);
    assert.deepEqual(data.lens?.chips[precheck as string], ['in: devices', 'out: report']);
    assert.ok(data.lens?.findings.includes(`data:unresolved:${post}.ref`));
    const code = await showLens('code');
    // No catalog in this workspace: the binding shows without a version.
    assert.equal(code.lens?.chips[upgrade as string]?.[0], 'ios_config');
    const timing = await showLens('timing');
    assert.deepEqual(timing.lens?.chips[precheck as string], ['serial 2 · 10m']);
    const none = await showLens(null);
    assert.equal(none.lens, undefined);
    assert.equal(doc.isDirty, false, 'a lens never edits the flow');
    assert.equal(doc.getText(), before);
  });

  it('Mark expected is one edit with the Git author; undo restores the bytes', async () => {
    const api = await testApi();
    const doc = await openDesigner(LENS);
    const before = doc.getText();
    const precheck = await idOf('precheck');
    const finding = `data:unused-output:${precheck}.report`;
    await showLens('data');
    const outcome = await api.run(LENS, {
      kind: 'acceptFinding',
      finding,
      node: precheck,
      reason: 'The report feeds the change ticket outside the flow',
    });
    assert.ok(outcome.ok, outcome.error);
    const decisions = (parse(doc.getText()) as FlowDocument).decisions;
    assert.deepEqual(decisions, [
      {
        kind: 'finding_accepted',
        finding,
        node: precheck,
        reason: 'The report feeds the change ticket outside the flow',
        by: 'AFD Test',
      },
    ]);
    const dom = await showLens('data', (d) => !!d.lens?.findings.includes(`${finding} (accepted)`));
    assert.ok(dom.lens);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
    await showLens(null);
  });

  (image ? it : it.skip)(
    `Inventory and Access lenses read the inventory in ${image ?? 'AFD_TEST_IMAGE'}`,
    async function () {
      this.timeout(240_000);
      const api = await testApi();
      const config = vscode.workspace.getConfiguration('afd');
      // Copied here, after the M3 runs: their vault check scans the repository (.vscode-test.mjs).
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
      cpSync(join(REPO, 'test/fixtures/lens/inventory'), join(root, 'lens', 'inventory'), {
        recursive: true,
      });
      await config.update(
        'run.inventory',
        'lens/inventory/hosts.yml',
        vscode.ConfigurationTarget.Workspace,
      );
      try {
        await openDesigner(LENS);
        const [drain, rollback, precheck, upgrade] = await Promise.all(
          ['drain', 'rollback', 'precheck', 'upgrade'].map(idOf),
        );
        api.setLens(LENS, 'inventory');
        await api.setTargets(LENS, 'edge_switches');
        const inv = api.lensFacts(LENS).inventory;
        assert.equal(inv?.state, 'ready', inv?.error);
        const f = inv?.facts;
        assert.deepEqual(f?.patterns.edge_switches, { count: 6, outside: 0, sample: [] });
        assert.equal(f?.patterns.core_spines?.outside, 2);
        assert.equal(f?.patterns.all?.count, 9);
        assert.deepEqual(Object.keys(f?.vaulted ?? {}), ['spine_enable_secret']);
        assert.equal(f?.vaulted.spine_enable_secret, 'lens/inventory/group_vars/core_spines.yml:3');
        const text = JSON.stringify(api.lensFacts(LENS));
        assert.ok(!text.includes('fictional') && !text.includes('$ANSIBLE_VAULT'));
        const dom = await withTimeout(
          showLens('inventory', (d) => (d.lens?.chips[drain as string]?.length ?? 0) === 2),
          30_000,
          'inventory chips',
        );
        assert.deepEqual(dom.lens?.chips[drain as string], [
          'edge_switches · 6',
          '+ core_spines · 2',
        ]);
        assert.deepEqual(dom.lens?.chips[rollback as string], ['+ all · 9']);
        assert.ok(dom.lens?.findings.includes(`inventory:broad-target:${rollback}`));
        assert.ok(dom.lens?.findings.includes('inventory:group-not-input:core_spines'));
        const access = await showLens(
          'access',
          (d) => (d.lens?.chips[precheck as string]?.length ?? 0) > 0,
        );
        assert.deepEqual(access.lens?.chips[precheck as string], ['user netops']);
        assert.deepEqual(access.lens?.chips[upgrade as string], ['netops-admin', 'become']);
        await showLens(null);
      } finally {
        await config.update('run.inventory', undefined, vscode.ConfigurationTarget.Workspace);
        rmSync(join(root, 'lens'), { recursive: true, force: true });
      }
    },
  );
});
