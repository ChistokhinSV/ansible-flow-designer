// AFD-26 inside VS Code: Import Ansible Playbooks writes new flows that open clean in the designer,
// a folder imports the playbooks picked (one flow each), an existing key is refused, and an AWX
// job template whose playbook is in the repository imports as its steps. With AFD_AWX_URL and
// AFD_AWX_TOKEN, a job template is also read from the lab AWX API.
import * as assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { ReimportOutcome } from '../../src/extension/import/reimport';
import { collectInputs } from '../../src/extension/run/inputs';
import { closeAll, openDesigner, testApi } from './helpers';

/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');
const NETOPS = join(REPO, 'test/fixtures/import/netops');
const url = process.env.AFD_AWX_URL;
const token = process.env.AFD_AWX_TOKEN;
const CMD_REIMPORT = 'afd.import.reimport';
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

  it('AFD-136: an include that leads out of the workspace is not read', async () => {
    const api = await testApi();
    made.add('netops-escape');
    // A task file next to the workspace folder, which a playbook inside reaches with `..`.
    const outside = join(root().fsPath, '..', 'afd136-outside.yml');
    writeFileSync(outside, '- name: SECRET TASK FROM OUTSIDE\n  ansible.builtin.ping:\n');
    const book = join(root().fsPath, 'netops', 'playbooks', 'escape.yml');
    writeFileSync(
      book,
      [
        '- name: Escape',
        '  hosts: all',
        '  tasks:',
        '    - name: Inside',
        '      ansible.builtin.ping:',
        '    - ansible.builtin.include_tasks: ../../../afd136-outside.yml',
        '',
      ].join('\n'),
    );
    try {
      const r = await api.importPlaybooks({ source: vscode.Uri.file(book), keys: ['netops-escape'] });
      assert.equal(r.error, undefined);
      const flow = await read(r.uris[0] as vscode.Uri);
      const text = JSON.stringify(flow);
      assert.ok(text.includes('Inside'), 'the task inside the workspace is imported');
      assert.ok(!text.includes('SECRET TASK FROM OUTSIDE'), 'the file outside is never read');
    } finally {
      rmSync(outside, { force: true });
    }
  });

  it('Re-import from Source (AFD-61): the source merged in one edit, the designer kept', async () => {
    const api = await testApi();
    made.add('netops-reimport');
    const book = vscode.Uri.joinPath(root(), 'netops', 'playbooks', 'reimport.yml');
    const write = (text: string) =>
      vscode.workspace.fs.writeFile(book, new TextEncoder().encode(text));
    const original = readFileSync(join(NETOPS, 'playbooks', 'prechecks.yml'), 'utf8');
    await write(original);
    const r = await api.importPlaybooks({ source: book, keys: ['netops-reimport'] });
    assert.equal(r.error, undefined);
    const uri = r.uris[0] as vscode.Uri;
    const doc = await openDesigner(uri);
    const step = (key: string) =>
      (parse(doc.getText()) as FlowDocument).nodes.find((n) => n.key === key || n.title === key);
    // The designer renames a step; the playbook changes it too, changes another and gains a task.
    const renamed = await api.run(uri, {
      kind: 'updateNode',
      id: step('record-the-pre-check')?.id as string,
      patch: { title: 'Record the result' },
    });
    assert.equal(renamed.ok, true);
    await write(
      `${original
        .replace('fail_msg: "Unsupported version', 'fail_msg: "Not supported: version')
        .replace('mode: "0644"', 'mode: "0640"')
        .trimEnd()}\n\n    - name: Report done\n      debug:\n        msg: done\n`,
    );
    const out = await vscode.commands.executeCommand<ReimportOutcome>(CMD_REIMPORT, uri, {
      take: [],
    });
    assert.equal(out?.error, undefined);
    assert.equal(out?.applied?.ok, true, out?.applied?.error);
    assert.deepEqual(
      [
        out?.plan?.updates.map((u) => u.key),
        out?.plan?.conflicts.map((u) => u.key),
        out?.plan?.adds.map((a) => a.step.title),
        out?.plan?.gone.length,
      ],
      [['check-the-version-is-supported'], ['record-the-pre-check'], ['Report done'], 0],
    );
    assert.match(
      JSON.stringify(step('check-the-version-is-supported')?.impl),
      /Not supported: version/,
    );
    assert.equal(step('record-the-pre-check')?.title, 'Record the result');
    assert.equal(step('record-the-pre-check')?.impl?.params?.mode, '0644');
    assert.equal(step('Report done')?.origin?.task, 'netops/playbooks/reimport.yml#Report done#1');
    const errors = api
      .diagnostics(uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
    assert.deepEqual(
      errors.map((d) => d.message),
      [],
    );
    // The conflict not taken was noted: nothing is offered again.
    const again = await vscode.commands.executeCommand<ReimportOutcome>(CMD_REIMPORT, uri, {
      take: [],
    });
    assert.equal(again?.applied, undefined);
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

  it('AFD-27: with an AI assistant, the prompt goes to the clipboard and nothing is written', async () => {
    const api = await testApi();
    const r = await api.importPlaybooks({
      source: vscode.Uri.joinPath(root(), 'netops'),
      playbooks: ['netops/site.yml'],
      keys: ['ai-site'],
      mode: 'ai',
      via: 'clipboard',
    });
    assert.equal(r.error, undefined);
    assert.equal(r.started, 'clipboard');
    assert.deepEqual(r.uris, []);
    assert.ok(r.prompt?.includes('- netops/site.yml → flows/ai-site/ai-site.flow.yaml'), r.prompt);
    assert.ok(r.prompt?.includes('source_outline'));
    assert.equal(await vscode.env.clipboard.readText(), r.prompt);
    assert.equal(
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root(), 'flows', 'ai-site')).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  it('AFD-27: the chat route opens the chat or falls back to the clipboard, never failing', async () => {
    const api = await testApi();
    const r = await api.importPlaybooks({
      source: vscode.Uri.joinPath(root(), 'netops', 'playbooks', 'prechecks.yml'),
      keys: ['ai-chat'],
      mode: 'ai',
      via: 'chat',
    });
    assert.equal(r.error, undefined);
    assert.ok(r.started === 'chat' || r.started === 'clipboard', String(r.started));
    console.log(`[afd27] chat route: ${r.started}`);
    assert.equal(await vscode.env.clipboard.readText(), r.prompt);
    // The chat keeps the focus (VS Code 1.140): a later test's Undo would go to its input box.
    for (const command of ['workbench.action.closeAuxiliaryBar', 'workbench.action.closePanel'])
      await Promise.resolve(vscode.commands.executeCommand(command)).catch(() => undefined);
  });

  it('AFD-27: AWX with an AI assistant writes a sanitized export for the assistant to read', async () => {
    const api = await testApi();
    const file = join(tmpdir(), `afd27-export-${Date.now()}.json`);
    writeFileSync(
      file,
      JSON.stringify({
        job_templates: [
          {
            name: 'Edge pre-checks',
            playbook: 'netops/playbooks/prechecks.yml',
            extra_vars: '{"out_dir": "/srv/reports", "api_token": "tok-example-123"}',
            project: { name: 'Netops', type: 'project' },
          },
        ],
      }),
    );
    try {
      made.add('ai-awx');
      const r = await api.importAwx({
        source: { kind: 'file', path: file, name: 'Edge pre-checks' },
        folder: root(),
        key: 'ai-awx',
        mode: 'ai',
        via: 'clipboard',
      });
      assert.equal(r.error, undefined);
      assert.equal(r.uri, undefined, 'the assistant writes the flow');
      assert.equal(
        vscode.workspace.asRelativePath(r.exportFile as vscode.Uri),
        'flows/ai-awx/source/awx-export.json',
      );
      const text = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(r.exportFile as vscode.Uri),
      );
      assert.ok(!text.includes('tok-example-123'), 'no secret value in the export');
      assert.ok(text.includes('"api_token": "$encrypted$"'));
      assert.ok(r.prompt?.includes('the AWX job template "Edge pre-checks"'), r.prompt);
      assert.equal(await vscode.env.clipboard.readText(), r.prompt);
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('AFD-28: a run never remembers an imported secret input, only the others', async () => {
    const stored = new Map<string, unknown>();
    const state = {
      keys: () => [...stored.keys()],
      get: <T>(k: string, d?: T) => (stored.has(k) ? (stored.get(k) as T) : d),
      update: async (k: string, v: unknown) => {
        stored.set(k, v);
      },
    } as unknown as vscode.Memento;
    const doc = {
      flow: {
        id: 'flow-1',
        inputs: {
          devices: { type: 'host_list', required: true, targets: true },
          enable_secret: { type: 'string', required: true },
        },
      },
    } as unknown as FlowDocument;
    const values = await collectInputs(
      doc,
      { devices: ['edge'], enable_secret: 'example-enable' },
      state,
    );
    assert.deepEqual(values, { devices: ['edge'], enable_secret: 'example-enable' });
    assert.deepEqual(stored.get('afd.inputs.flow-1'), { devices: ['edge'] });
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
