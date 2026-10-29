// AFD-5: with the Red Hat YAML extension installed, *.flow.yaml must be validated against our flow
// schema (contributes.yamlValidation), never SchemaStore's Estuary Flow catalog that also claims
// the pattern. Opt-in label `yaml` (just test-yaml): it installs redhat.vscode-yaml.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { closeAll, flowUri, withTimeout } from './helpers';

const yamlDiagnostics = (uri: vscode.Uri) =>
  vscode.languages
    .getDiagnostics(uri)
    .filter((d) => String(d.source ?? '').startsWith('yaml-schema'));

/** Resolves once the YAML diagnostics of `uri` satisfy `ok` (they arrive asynchronously). */
function yamlSettles(uri: vscode.Uri, ok: (d: vscode.Diagnostic[]) => boolean): Promise<void> {
  return new Promise((resolve) => {
    if (ok(yamlDiagnostics(uri))) return resolve();
    const sub = vscode.languages.onDidChangeDiagnostics((e) => {
      if (!e.uris.some((u) => u.toString() === uri.toString())) return;
      if (!ok(yamlDiagnostics(uri))) return;
      sub.dispose();
      resolve();
    });
  });
}

describe('AFD-5: the YAML extension validates flows with the flow schema', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('redhat.vscode-yaml');
    assert.ok(ext, 'redhat.vscode-yaml is installed for this suite');
    await ext.activate();
  });
  afterEach(closeAll);

  for (const key of ['edge-baseline', 'os-upgrade']) {
    it(`${key}: a schema error comes from our schema, and the valid file has none`, async () => {
      const uri = flowUri(key);
      const doc = await vscode.workspace.openTextDocument(uri);
      assert.equal(doc.languageId, 'yaml');
      // Break the document so the YAML server must report, which proves it validated this file.
      const line = doc.getText().split('\n').indexOf('schema_version: 1');
      assert.ok(line >= 0);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(line, 0, line, 17), 'schema_version: 2');
      await vscode.workspace.applyEdit(edit);
      await withTimeout(
        yamlSettles(uri, (d) => d.length > 0),
        60_000,
        'YAML diagnostics for a broken flow',
      );
      const broken = yamlDiagnostics(uri);
      // Mocha's diff output hides assertion messages, so failures throw the diagnostics themselves.
      const wrong =
        broken.length !== 1 ||
        broken[0]?.range.start.line !== line ||
        String(broken[0]?.source).includes('Estuary');
      if (wrong) throw new Error(broken.map((d) => `${d.source}: ${d.message}`).join('\n'));
      // Restore: the example is valid against our schema, so the YAML errors go away.
      const undo = new vscode.WorkspaceEdit();
      undo.replace(uri, new vscode.Range(line, 0, line, 17), 'schema_version: 1');
      await vscode.workspace.applyEdit(undo);
      await withTimeout(
        yamlSettles(uri, (d) => d.length === 0),
        30_000,
        'no YAML diagnostics on the valid flow',
      );
    });
  }
});
