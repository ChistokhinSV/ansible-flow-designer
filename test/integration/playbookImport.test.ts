// AFD-26 inside VS Code: Import Ansible Playbooks writes new flows that open clean in the designer,
// a folder imports the playbooks picked (one flow each), an existing key is refused, and an AWX
// job template whose playbook is in the repository imports as its steps. With AFD_AWX_URL and
// AFD_AWX_TOKEN, a job template is also read from the lab AWX API.
import * as assert from 'node:assert/strict';
import { cpSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, openDesigner, testApi } from './helpers';

/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');
const NETOPS = join(REPO, 'test/fixtures/import/netops');
const url = process.env.AFD_AWX_URL;
const token = process.env.AFD_AWX_TOKEN;
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri as vscode.Uri;
const read = async (uri: vscode.Uri) =>
  parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as FlowDocument;

describe('AFD-26: import playbooks and AWX job templates as is', function () {
  this.timeout(300_000);
  const made = new Set<string>();
  // The fixture has a vaulted variable: copied in for this suite only, as the lens fixture is, so
  // the vault check of the runs never sees it.
  before(() => cpSync(NETOPS, join(root().fsPath, 'netops'), { recursive: true }));
  afterEach(closeAll);
  after(() => {
    for (const key of made)
      rmSync(join(root().fsPath, 'flows', key), { recursive: true, force: true });
    rmSync(join(root().fsPath, 'netops'), { recursive: true, force: true });
  });

  it('a playbook: one new flow, opened clean, its data wired', async () => {
    const api = await testApi();
    made.add('netops-prechecks');
    const r = await api.importPlaybooks({
      source: vscode.Uri.joinPath(root(), 'netops', 'playbooks', 'prechecks.yml'),
      keys: ['netops-prechecks'],
    });
    assert.equal(r.error, undefined);
    assert.equal(r.uris.length, 1);
    assert.deepEqual(r.counts, { steps: 4, implemented: 4, drafts: 0 });
    const uri = r.uris[0] as vscode.Uri;
    const doc = await openDesigner(uri);
    assert.equal(doc.isDirty, false, 'opening an imported flow changes nothing');
    const flow = parse(doc.getText()) as FlowDocument;
    assert.deepEqual(flow.flow.imported_from, {
      kind: 'playbook',
      path: 'netops/playbooks/prechecks.yml',
    });
    assert.equal(flow.layout, undefined, 'like a new flow, no positions are stored');
    assert.deepEqual(flow.nodes.find((n) => n.key === 'check-the-version-is-supported')?.inputs, {
      version_check: { type: 'dict', from: 'read-the-software-version.version_check' },
    });
    let dom = await api.inspect(uri);
    for (let i = 0; i < 50 && dom.nodes.length < 6; i++) {
      await new Promise((res) => setTimeout(res, 100));
      dom = await api.inspect(uri);
    }
    assert.equal(dom.nodes.length, 6, 'start, four steps, done');
    assert.equal(dom.banner, 4, 'every step leaves its failures open, as the playbook does');
    const errors = api
      .diagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(
      errors.map((d) => d.message),
      [],
    );

    const again = await api.importPlaybooks({
      source: vscode.Uri.joinPath(root(), 'netops', 'playbooks', 'prechecks.yml'),
      keys: ['netops-prechecks'],
    });
    assert.match(again.error ?? '', /already exists/);
  });

  it('a folder: the playbooks picked, one flow each, with keys of their own and the notes', async () => {
    const api = await testApi();
    const r = await api.importPlaybooks({
      source: vscode.Uri.joinPath(root(), 'netops'),
      playbooks: ['netops/site.yml', 'netops/playbooks/rollback.yml'],
    });
    for (const u of r.uris) made.add(u.path.split('/').at(-2) as string);
    assert.equal(r.error, undefined);
    assert.deepEqual(
      r.uris.map((u) => vscode.workspace.asRelativePath(u)),
      ['flows/site/site.flow.yaml', 'flows/rollback/rollback.flow.yaml'],
    );
    assert.ok(
      r.notes.includes(
        'site: Imported by name only (vault, prompted or secret-looking): enable_secret, snmp_community. Give them when running.',
      ),
      r.notes.join('\n'),
    );
    const site = await read(r.uris[0] as vscode.Uri);
    assert.deepEqual(
      site.nodes.map((n) => n.key),
      ['start', 'pre-checks', 'baseline', 'done'],
    );
    assert.ok(!JSON.stringify(site).includes('ANSIBLE_VAULT'));
  });

  it('an AWX job template from an export file: its playbook steps in a subflow', async () => {
    const api = await testApi();
    const file = join(tmpdir(), `afd26-export-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        job_templates: [
          {
            name: 'Edge pre-checks',
            playbook: 'netops/playbooks/prechecks.yml',
            limit: 'edge',
            become_enabled: true,
            project: { name: 'Netops', type: 'project' },
          },
        ],
      }),
    );
    try {
      made.add('edge-pre-checks');
      const r = await api.importAwx({
        source: { kind: 'file', path: file, name: 'Edge pre-checks' },
        folder: root(),
        key: 'edge-pre-checks',
      });
      assert.equal(r.error, undefined);
      assert.deepEqual(r.counts, { steps: 4, implemented: 4, drafts: 0 });
      const flow = await read(r.uri as vscode.Uri);
      assert.equal(flow.flow.imported_from?.kind, 'awx_job_template');
      const sub = flow.nodes.find((n) => n.key === 'edge-pre-checks');
      assert.equal(sub?.type, 'subflow');
      assert.equal(sub?.subflow?.nodes?.length, 4);
      assert.ok(sub?.subflow?.nodes?.every((n) => n.settings?.become === true));
      await openDesigner(r.uri as vscode.Uri);
      const errors = api
        .diagnostics(r.uri as vscode.Uri)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      assert.deepEqual(
        errors.map((d) => d.message),
        [],
      );
    } finally {
      rmSync(file, { force: true });
    }
  });

  (url && token ? it : it.skip)('an AWX job template from the lab AWX API', async () => {
    const api = await testApi();
    const scope = root();
    assert.equal(await api.awxToken(scope, token as string), undefined);
    try {
      made.add('awx-precheck-api');
      const r = await api.importAwx({
        source: { kind: 'awx', name: 'AFD fixture · precheck', template: 'job' },
        folder: scope,
        key: 'awx-precheck-api',
      });
      assert.equal(r.error, undefined);
      const flow = await read(r.uri as vscode.Uri);
      assert.equal(flow.flow.imported_from?.kind, 'awx_job_template');
      assert.equal(typeof flow.flow.imported_from?.id, 'number');
      // The fixture template runs the playbook the designer generated: it stays one playbook step.
      const step = flow.nodes.find((n) => n.type === 'task');
      assert.equal(step?.impl?.kind, 'playbook');
      assert.equal(step?.status, 'implemented');
    } finally {
      await vscode.commands.executeCommand('afd.awx.clearToken', scope);
    }
  });
});
