// AFD-115 inside VS Code: renaming a step in the designer renames it in the scenarios file in the
// same edit, saved with the flow; the live check simulates the scenarios and shows a host that
// would end elsewhere on its expect line, and on the flow. No Ansible needed.
import * as assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { closeAll, openDesigner, testApi } from './helpers';

/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('AFD-115: scenarios stay current', () => {
  let dir = '';
  afterEach(async () => {
    await closeAll();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a step renamed in the designer is renamed in the scenarios file; a miss shows on its expect line', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    dir = join(root, 'flows', 'routing-levels-live');
    mkdirSync(dir, { recursive: true });
    for (const f of ['routing-levels.flow.yaml', 'routing-levels.scenarios.yaml'])
      cpSync(join(REPO, 'test/fixtures/engine', f), join(dir, f));
    const flow = vscode.Uri.file(join(dir, 'routing-levels.flow.yaml'));
    const scenarios = vscode.Uri.file(join(dir, 'routing-levels.scenarios.yaml'));
    const doc = await openDesigner(flow);
    const api = await testApi();
    const gate = (/id: (\w+)\n {4}key: gate\n/.exec(doc.getText()) ?? [])[1] as string;
    assert.ok(gate, 'gate id');

    const outcome = await api.run(flow, {
      kind: 'updateNode',
      id: gate,
      patch: { key: 'final-gate' },
    });
    assert.equal(outcome.ok, true, outcome.error);
    const file = await vscode.workspace.openTextDocument(scenarios);
    assert.match(file.getText(), /\n {6}final-gate:\n/);
    assert.match(file.getText(), /h03: final-gate\.failed_hosts/);
    assert.equal(file.isDirty, true, 'changed with the flow, not saved yet');
    await doc.save();
    await until(() => !file.isDirty, 'saved with the flow');
    assert.match(readFileSync(scenarios.fsPath, 'utf8'), /h03: final-gate\.failed_hosts/);

    // Every scenario passes in the simulation: no warning on the file or the flow.
    const misses = (uri: vscode.Uri) =>
      vscode.languages.getDiagnostics(uri).filter((d) => d.message.startsWith('Simulated:'));
    const onFlow = () =>
      vscode.languages.getDiagnostics(flow).filter((d) => d.code === 'scenario-miss');
    await until(async () => (await api.scenarioCheck(flow))?.results.length === 3, 'checked');
    assert.deepEqual(misses(scenarios), []);
    assert.deepEqual(onFlow(), []);

    // A wrong expectation: a warning on h03's expect line, and one on the flow.
    const edit = new vscode.WorkspaceEdit();
    const at = file.getText().indexOf('h03: final-gate.failed_hosts');
    edit.replace(
      scenarios,
      new vscode.Range(file.positionAt(at + 5), file.positionAt(at + 28)),
      'done',
    );
    assert.ok(await vscode.workspace.applyEdit(edit));
    await until(() => misses(scenarios).length === 1, 'the miss on the expect line');
    const [miss] = misses(scenarios);
    assert.equal(miss?.severity, vscode.DiagnosticSeverity.Warning);
    assert.equal(miss?.range.start.line, file.positionAt(at).line);
    assert.match(
      miss?.message ?? '',
      /^Simulated: h03 ended at Gate's open failed_hosts; the scenario expected Done$/,
    );
    await until(() => onFlow().length === 1, 'the miss on the flow');
    assert.match(onFlow()[0]?.message ?? '', /^Scenario "a failed stage is handled/);
  });

  it('AFD-116: a scenario made from the designer starts at the simulated ends; Undo takes each change back', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    dir = join(root, 'flows', 'routing-levels-new');
    mkdirSync(dir, { recursive: true });
    cpSync(
      join(REPO, 'test/fixtures/engine/routing-levels.flow.yaml'),
      join(dir, 'routing-levels.flow.yaml'),
    );
    const flow = vscode.Uri.file(join(dir, 'routing-levels.flow.yaml'));
    const file = join(dir, 'routing-levels.scenarios.yaml');
    const api = await testApi();
    await openDesigner(flow);
    const add = await api.scenarioEdit(flow, {
      kind: 'add',
      scenario: { name: 'gate fails', inputs: { devices: ['host-01', 'host-02'] }, expect: {} },
    });
    assert.equal(add.ok, true, add.error);
    // Created, with every host where the flow sends it now.
    assert.match(readFileSync(file, 'utf8'), /host-01: done\s+host-02: done/);
    const force = await api.scenarioEdit(flow, {
      kind: 'force',
      name: 'gate fails',
      step: 'gate',
      outcome: 'failed',
      hosts: ['host-02'],
    });
    assert.equal(force.ok, true, force.error);
    await until(
      async () => (await api.scenarioCheck(flow))?.results[0]?.passed === false,
      'failing in the simulation',
    );
    const accept = await api.scenarioEdit(flow, { kind: 'acceptEnds', name: 'gate fails' });
    assert.equal(accept.ok, true, accept.error);
    assert.match(readFileSync(file, 'utf8'), /host-02: gate\.failed_hosts/);
    await until(
      async () => (await api.scenarioCheck(flow))?.results[0]?.passed === true,
      'passing',
    );
    // Three changes, three undos: the last one deletes the file it created.
    for (let i = 0; i < 3; i++) assert.equal((await api.scenarioUndo(flow)).ok, true);
    await until(() => !existsSync(file), 'the file is gone');
    assert.equal((await api.scenarioUndo(flow)).ok, false);
  });

  it('a rename through the flow tools renames it in the scenarios file and saves both', async () => {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    dir = join(root, 'flows', 'routing-levels-tools');
    mkdirSync(dir, { recursive: true });
    for (const f of ['routing-levels.flow.yaml', 'routing-levels.scenarios.yaml'])
      cpSync(join(REPO, 'test/fixtures/engine', f), join(dir, f));
    const scenarios = join(dir, 'routing-levels.scenarios.yaml');
    const api = await testApi();
    const r = await api.aiTool('flow_edit', {
      path: 'flows/routing-levels-tools/routing-levels.flow.yaml',
      ops: [{ op: 'update_node', node: 'stage', key: 'prep' }],
    });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Scenarios updated: stage\/prepare → prep\/prepare\./);
    await until(() => readFileSync(scenarios, 'utf8').includes('prep/prepare:'), 'saved');
    const file = await vscode.workspace.openTextDocument(vscode.Uri.file(scenarios));
    assert.equal(file.isDirty, false);
  });
});
