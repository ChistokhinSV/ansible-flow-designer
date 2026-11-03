// M9 acceptance inside VS Code (AFD-15): Import AWX Workflow from the export fixture writes one new
// flow that opens clean in the designer, laid out, with the banner on the failures AWX does not
// handle. With AFD_TEST_IMAGE the imported flow runs as a skeleton; with AFD_AWX_URL and
// AFD_AWX_TOKEN the same workflow imported from the lab AWX API gives the same flow.
import * as assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { DomSummary } from '../../src/core/protocol';
import { closeAll, openDesigner, runEnvironment, testApi, withTimeout } from './helpers';

/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');
const EXPORT = join(REPO, 'test/fixtures/awx/import/export.json');
const OUTER = 'AFD fixture · edge upgrade';
const image = runEnvironment;
const url = process.env.AFD_AWX_URL;
const token = process.env.AFD_AWX_TOKEN;
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri as vscode.Uri;

async function inspectLevel(
  uri: vscode.Uri,
  level: string,
  ready: (d: DomSummary) => boolean = () => true,
): Promise<DomSummary> {
  const api = await testApi();
  for (let i = 0; i < 50; i++) {
    const dom = await api.inspect(uri);
    if (dom.level === level && (level === 'root' || dom.frame) && ready(dom)) return dom;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the canvas never showed level ${level}`);
}

/** Nodes and wires by key, per level: two imports differ only in their ids. */
function shape(doc: FlowDocument): unknown {
  const level = (nodes: FlowDocument['nodes'], edges: FlowDocument['edges']): unknown => {
    const key = new Map(nodes.map((n) => [n.id, n.key]));
    return {
      nodes: nodes
        .map((n) => ({
          key: n.key,
          type: n.type,
          status: n.status,
          impl: n.impl,
          ports: n.ports,
          settings: n.settings,
          inner: n.subflow ? level(n.subflow.nodes ?? [], n.subflow.edges ?? []) : undefined,
        }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      edges: edges
        .map((e) => `${key.get(e.from.node)}.${e.from.port} -> ${key.get(e.to.node)}`)
        .sort(),
    };
  };
  return { inputs: doc.flow.inputs, ...(level(doc.nodes, doc.edges) as object) };
}

describe('M9 acceptance: import AWX workflows', function () {
  this.timeout(300_000);
  const made = new Set<string>();
  const importFile = async (key: string) => {
    made.add(key);
    return (await testApi()).importAwx({
      source: { kind: 'file', path: EXPORT, name: OUTER },
      folder: root(),
      key,
    });
  };
  afterEach(closeAll);
  after(() => {
    for (const key of made)
      rmSync(join(root().fsPath, 'flows', key), { recursive: true, force: true });
    rmSync(join(root().fsPath, 'hello_world.yml'), { force: true });
  });

  it('from an export file: one new flow, laid out, opened clean; the banner shows unhandled failures', async () => {
    const api = await testApi();
    const r = await importFile('edge-upgrade');
    assert.equal(r.error, undefined);
    assert.ok(r.uri);
    assert.deepEqual(r.counts, { steps: 10, implemented: 7, drafts: 3 });
    assert.ok(r.notes.some((n) => n.includes('hello_world.yml')));
    const doc = await openDesigner(r.uri);
    assert.equal(doc.isDirty, false, 'opening an imported flow changes nothing');
    const text = doc.getText();
    assert.ok(!text.includes('$encrypted$'));
    const flow = parse(text) as FlowDocument;
    const upgrade = flow.nodes.find((n) => n.key === 'upgrade');
    const all = [...flow.nodes, ...(upgrade?.subflow?.nodes ?? [])];
    for (const n of all) assert.ok(flow.layout?.[n.id], `${n.key} has a position`);

    const top = await inspectLevel(r.uri, 'root', (d) => d.edges === 15);
    assert.equal(top.nodes.length, 10);
    assert.equal(top.banner, 3, 'verify, report and notify fail with no AWX failure path');
    const errors = api
      .diagnostics(r.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(
      errors.map((d) => d.message),
      [],
    );
    api.openLevel(r.uri, upgrade?.id as string);
    const inside = await inspectLevel(
      r.uri,
      upgrade?.id as string,
      (d) => (d.frame?.wires ?? 0) >= 2,
    );
    assert.equal(inside.nodes.length, 6);
    assert.equal(inside.frame?.wires, 2, 'the entry and the ok_hosts exit');

    const again = await importFile('edge-upgrade');
    assert.match(again.error ?? '', /already exists/);
  });

  (image ? it : it.skip)(
    `the imported flow runs as a skeleton in ${image ?? 'AFD_TEST_IMAGE'}`,
    async () => {
      const api = await testApi();
      // With the Demo Project's playbook in the repository, every job template node is bound.
      writeFileSync(
        join(root().fsPath, 'hello_world.yml'),
        '- name: Hello (fictional stand-in for the AWX demo playbook)\n  hosts: "{{ afd_hosts }}"\n  gather_facts: false\n  tasks:\n    - ansible.builtin.debug:\n        msg: Hello\n',
      );
      try {
        const r = await importFile('edge-upgrade-run');
        assert.deepEqual(r.counts, { steps: 10, implemented: 8, drafts: 2 });
        await openDesigner(r.uri as vscode.Uri);
        const run = await withTimeout(
          api.runFlow(r.uri as vscode.Uri, {
            mode: 'check',
            inputs: { devices: ['sw-edge-01', 'sw-edge-02'], change_ticket: 'CHG0001234' },
          }),
          240_000,
          'skeleton run',
        );
        if (run.state !== 'done') throw new Error(JSON.stringify(run));
        assert.equal(run.rc, 0);
        assert.deepEqual(run.summary?.failures, []);
      } finally {
        // The lab test below compares with the first import, made without it.
        rmSync(join(root().fsPath, 'hello_world.yml'), { force: true });
      }
    },
  );

  (url && token ? it : it.skip)(
    'from the lab AWX API: the same flow as from the export file',
    async () => {
      const api = await testApi();
      const scope = root();
      assert.equal(await api.awxToken(scope, token as string), undefined);
      try {
        made.add('edge-upgrade-api');
        const r = await api.importAwx({
          source: { kind: 'awx', name: OUTER },
          folder: scope,
          key: 'edge-upgrade-api',
        });
        assert.equal(r.error, undefined);
        const fromApi = parse(
          new TextDecoder().decode(await vscode.workspace.fs.readFile(r.uri as vscode.Uri)),
        ) as FlowDocument;
        const file = vscode.Uri.joinPath(scope, 'flows', 'edge-upgrade', 'edge-upgrade.flow.yaml');
        const fromFile = parse(
          new TextDecoder().decode(await vscode.workspace.fs.readFile(file)),
        ) as FlowDocument;
        assert.deepEqual(shape(fromApi), shape(fromFile));
        assert.equal(typeof fromApi.flow.imported_from?.id, 'number');
        assert.equal(fromFile.flow.imported_from?.id, undefined);
        assert.ok(!JSON.stringify(fromApi).includes('$encrypted$'));
      } finally {
        await vscode.commands.executeCommand('afd.awx.clearToken', scope);
      }
    },
  );
});
