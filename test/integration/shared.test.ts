// Shared subflows inside VS Code (AFD-60): Insert Shared Subflow copies another flow's subflow in
// one edit, a newer source version is a problem with an Update quick fix, and Update copies it
// again. The flows are copies made for the test and removed afterwards.
import * as assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('AFD-60: shared subflows', () => {
  afterEach(closeAll);

  it('Insert copies the subflow pinned to its version; a newer source is a problem; Update copies it again', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const src = join(root, 'flows', 'shared-src');
    const dst = join(root, 'flows', 'shared-dst');
    mkdirSync(src, { recursive: true });
    mkdirSync(dst, { recursive: true });
    cpSync(flowUri('os-upgrade').fsPath, join(src, 'shared-src.flow.yaml'));
    cpSync(flowUri('edge-baseline').fsPath, join(dst, 'shared-dst.flow.yaml'));
    const target = vscode.Uri.file(join(dst, 'shared-dst.flow.yaml'));
    try {
      const api = await testApi();
      const doc = await openDesigner(target);
      assert.equal((await api.run(target, { kind: 'upgradeFormat' })).ok, true);
      const pick = '../shared-src/shared-src.flow.yaml#upgrade-os';
      const added = await vscode.commands.executeCommand<{ ok: boolean; error?: string }>(
        'afd.flow.insertShared',
        target,
        { pick },
      );
      assert.equal(added?.ok, true, added?.error);
      const copy = () =>
        (parse(doc.getText()) as FlowDocument).nodes.find((n) => n.key === 'upgrade-os');
      const srcFile = join(src, 'shared-src.flow.yaml');
      const was = (parse(readFileSync(srcFile, 'utf8')) as FlowDocument).flow.version;
      assert.deepEqual(
        { from: copy()?.ref?.from, version: copy()?.ref?.version },
        { from: pick, version: was },
      );
      // The source moves on a version: the copy's problem offers Update.
      // Saved the way the editor saves it, so the file service reports the change.
      await vscode.workspace.fs.writeFile(
        vscode.Uri.file(srcFile),
        new TextEncoder().encode(
          readFileSync(srcFile, 'utf8').replace(/^ {2}version: \d+$/m, `  version: ${was + 1}`),
        ),
      );
      let problem: vscode.Diagnostic | undefined;
      for (let i = 0; i < 40 && !problem; i++) {
        problem = vscode.languages.getDiagnostics(target).find((d) => d.code === 'shared-source');
        if (!problem) await pause(250);
      }
      assert.match(
        problem?.message ?? '',
        new RegExp(`at version ${was + 1}, this copy at ${was}`),
      );
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        target,
        problem?.range,
      );
      assert.ok(actions?.some((a) => a.title === 'Update Shared Subflow'));
      await vscode.commands.executeCommand('afd.flow.updateShared', target, copy()?.id);
      assert.equal(copy()?.ref?.version, was + 1);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    } finally {
      await closeAll();
      rmSync(src, { recursive: true, force: true });
      rmSync(dst, { recursive: true, force: true });
    }
  });
});
