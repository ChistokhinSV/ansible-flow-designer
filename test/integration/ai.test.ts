// AFD-19 acceptance inside VS Code: a flow written by hand shows the banner and its errors, Complete
// IDs is one edit that one undo reverts; Copilot's flow tools are registered and edit through one
// undo step, saving only a file that had no unsaved changes; Set Up AI Assistants writes the skill
// and registrations; the MCP server runs on VS Code's own runtime.
import * as assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { scenariosConfirmation } from '../../src/extension/ai/lmTools';
import { lmTools } from '../../src/extension/compat';
import { closeAll, flowUri, openDesigner, testApi, withTimeout } from './helpers';

const ROOT = join(__dirname, '../../..');
const EDGE = flowUri('edge-baseline');

async function until(check: () => boolean | Promise<boolean>, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** The server arguments setup registered for Gemini. */
const server = (home: string): string[] =>
  JSON.parse(readFileSync(join(home, '.gemini/settings.json'), 'utf8')).mcpServers['ansible-flow']
    .args;

describe('AFD-19 acceptance: AI assistants', () => {
  afterEach(closeAll);

  it('a flow written by hand: banner, errors, Complete IDs quick fix in one undo step', async () => {
    const api = await testApi();
    const uri = vscode.Uri.joinPath(EDGE, '../../hand/hand.flow.yaml');
    await vscode.workspace.fs.writeFile(
      uri,
      readFileSync(join(ROOT, 'test/fixtures/flows/hand-written.flow.yaml')),
    );
    try {
      const doc = await openDesigner(uri);
      await until(async () => (await api.inspect(uri)).idGaps !== null, 'banner');
      const gaps = api.diagnostics(uri).filter((d) => d.code === 'missing-id');
      assert.ok(gaps.length > 0, 'missing-id diagnostics');
      const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
        'vscode.executeCodeActionProvider',
        uri,
        gaps[0]?.range,
      );
      const fix = actions.find((a) => a.title.startsWith('Complete IDs'));
      assert.ok(fix?.command, 'the quick fix is offered');
      const before = doc.getText();
      const version = doc.version;
      await vscode.commands.executeCommand(fix.command.command, ...(fix.command.arguments ?? []));
      assert.equal(doc.version, version + 1, 'one edit');
      await until(async () => (await api.inspect(uri)).idGaps === null, 'banner gone');
      assert.deepEqual(
        api.diagnostics(uri).filter((d) => d.code === 'missing-id' || d.code === 'unknown-key'),
        [],
      );
      await vscode.commands.executeCommand('undo');
      assert.equal(doc.getText(), before);
    } finally {
      await closeAll();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, '..'), { recursive: true });
    }
  });

  it('Copilot sees the flow tools', function () {
    // AFD-171: on the engine floor (VS Code 1.94) there is no tools API; activation still works.
    const lm = lmTools(vscode);
    if (!lm) this.skip();
    const names = lm.tools.map((t) => t.name);
    for (const t of ['afd_flow_describe', 'afd_flow_edit', 'afd_flow_validate', 'afd_flow_new'])
      assert.ok(names.includes(t), `${t} registered`);
  });

  it('a tool edit on a file with unsaved changes is one undo step and is not saved', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    const edit = new vscode.WorkspaceEdit();
    edit.insert(EDGE, new vscode.Position(0, 0), '# draft\n');
    await vscode.workspace.applyEdit(edit);
    const before = doc.getText();
    const r = await api.aiTool('flow_edit', {
      path: 'flows/edge-baseline/edge-baseline.flow.yaml',
      ops: [{ op: 'add_node', type: 'task', title: 'Check NTP', on_wire: 'precheck.ok_hosts' }],
    });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Not saved: the file had unsaved changes/);
    assert.ok(doc.isDirty);
    await until(
      async () =>
        (await api.inspect(EDGE)).nodes.length ===
        (parse(doc.getText()) as FlowDocument).nodes.length,
      'canvas shows the new node',
    );
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('a tool edit on a saved file saves it: version bump and generated code as on any save', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    // The version moves once per commit: HEAD's version + 1, however often other suites saved.
    const head = parse(readFileSync(join(ROOT, 'examples/edge-baseline.flow.yaml'), 'utf8'));
    const was = (head as FlowDocument).flow.version;
    const r = await api.aiTool('flow_edit', {
      ops: [{ op: 'leave_open', at: 'precheck.failed_hosts', reason: 'Nothing changed yet' }],
    });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Saved/);
    assert.ok(!doc.isDirty);
    assert.equal((parse(doc.getText()) as FlowDocument).flow.version, was + 1);
    const code = await withTimeout(
      api.savedCode(EDGE) as Promise<{ ok: boolean }>,
      30_000,
      'codegen',
    );
    assert.ok(code.ok);
    const outside = await api.aiTool('flow_describe', { path: '../outside.flow.yaml' });
    assert.ok(outside.isError);
  });

  it('Set Up AI Assistants writes skill copies and registrations; Remove takes them back', async () => {
    const api = await testApi();
    const home = mkdtempSync(join(tmpdir(), 'afd-ai-home-'));
    try {
      writeFileSync(join(home, 'placeholder'), '');
      const agents = ['codex', 'gemini', 'opencode', 'zcode'] as const;
      const items = await api.setupAi({ agents: [...agents], scope: 'user', home });
      // OpenCode and ZCode read the skill copy in ~/.agents/skills that Codex gets.
      assert.deepEqual(
        items?.map((i) => `${i.agent} ${i.what} ${i.action}`),
        [
          'codex skill create',
          'codex mcp create',
          'gemini skill create',
          'gemini mcp create',
          'opencode mcp create',
          'zcode mcp create',
        ],
      );
      const zcode = JSON.parse(readFileSync(join(home, '.agents/mcp.json'), 'utf8'));
      assert.deepEqual(zcode.mcpServers['ansible-flow'].args, server(home));
      const skill = readFileSync(join(home, '.agents/skills/ansible-flow/SKILL.md'), 'utf8');
      assert.match(skill, /^---\nname: ansible-flow\n/);
      readFileSync(join(home, '.agents/skills/ansible-flow/references/ops.md'), 'utf8');
      const args = server(home);
      assert.match(args[0] ?? '', /mcp[\\/]mcp\.js$/);
      readFileSync(args[0] ?? '');
      const removed = await api.removeAi({ agents: [...agents], home });
      assert.equal(removed?.length, 6);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('the MCP server runs on VS Code’s runtime (ELECTRON_RUN_AS_NODE)', async () => {
    const child = spawn(process.execPath, [join(ROOT, 'dist/mcp.js')], {
      cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
    });
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 't', version: '1' },
      },
    });
    await until(() => out.includes('"id":1'), 'initialize');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'flow_list', arguments: {} },
    });
    await until(() => out.includes('"id":2'), 'flow_list');
    child.kill();
    assert.match(out, /flows\/edge-baseline\/edge-baseline\.flow\.yaml/);
  });

  it('AFD-165: flow_scenarios says what each action does; list and check ask nothing', () => {
    const at = (action: string, extra: Record<string, unknown> = {}) =>
      scenariosConfirmation({ action, ...extra }, 'flows/x/x.flow.yaml', 'Scenarios');
    const text = (action: string, extra?: Record<string, unknown>) => {
      const m = at(action, extra).confirmationMessages?.message;
      return typeof m === 'string' ? m : (m?.value ?? '');
    };
    assert.equal(at('list').confirmationMessages, undefined);
    assert.equal(at('check').confirmationMessages, undefined);
    assert.equal(at('verify').confirmationMessages?.title, 'Verify Scenarios in Ansible?');
    assert.match(text('verify'), /ansible-playbook/);
    assert.equal(at('add').confirmationMessages?.title, 'Edit Scenarios?');
    assert.match(text('add', { name: 'happy path' }), /Add the scenario "happy path"/);
  });
});
