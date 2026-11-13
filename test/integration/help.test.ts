// AFD-22 inside VS Code: Open Sample Flow copies a bundled sample and opens it in the designer
// (and never overwrites one already there), Open User Guide shows a guide page in the Markdown
// preview (and nothing outside docs/guide), Get Started opens the walkthrough, and designer edits
// set the walkthrough's tour keys. AFD-201: the feedback commands open links and send nothing; a
// designer showing a flow with steps counts a day of use. AFD-263: an uninstall is asked about in a
// notice, and the form opens only from its button.
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { dayOf, FEEDBACK_PAGE, ISSUES_URL } from '../../src/core/feedback/feedback';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi, VIEW_TYPE } from './helpers';

const ROOT = join(__dirname, '../../..');

async function until(check: () => boolean, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

describe('AFD-22 acceptance: user help', () => {
  afterEach(closeAll);

  it('Open Sample Flow copies the sample into flows/<key>/ and opens the designer; a second run keeps changes', async () => {
    await testApi();
    const uri = flowUri('firewall-upgrade');
    await vscode.commands.executeCommand('afd.help.openSample', 'firewall-upgrade');
    await until(() => activeTab()?.input instanceof vscode.TabInputCustom, 'designer tab');
    const input = activeTab()?.input as vscode.TabInputCustom;
    assert.equal(input.viewType, VIEW_TYPE);
    assert.equal(input.uri.toString(), uri.toString());
    const copied = readFileSync(uri.fsPath, 'utf8');
    assert.equal(copied, readFileSync(join(ROOT, 'samples/firewall-upgrade.flow.yaml'), 'utf8'));
    await closeAll();
    // Changed while following a tutorial: opened as it is.
    const changed = `${copied}# my notes\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(changed));
    await vscode.commands.executeCommand('afd.help.openSample', 'firewall-upgrade');
    await until(() => activeTab()?.input instanceof vscode.TabInputCustom, 'designer tab again');
    assert.equal(readFileSync(uri.fsPath, 'utf8'), changed);
    await closeAll();
    // Other suites list the workspace's flows.
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, '..'), { recursive: true });
  });

  it('AFD-28: Open Sample copies the sample playbooks into a free folder only, and they import clean', async () => {
    const api = await testApi();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri as vscode.Uri;
    const exists = async (u: vscode.Uri) =>
      vscode.workspace.fs.stat(u).then(
        () => true,
        () => false,
      );
    // The test repository has its own ansible.cfg: refused, nothing copied.
    await vscode.commands.executeCommand('afd.help.openSample', 'playbooks/edge-baseline');
    assert.equal(await exists(vscode.Uri.joinPath(root, 'site.yml')), false);
    // A free folder gets the whole sample, and site.yml opens.
    const practice = vscode.Uri.joinPath(root, 'practice');
    try {
      await vscode.commands.executeCommand(
        'afd.help.openSample',
        'playbooks/edge-baseline',
        practice,
      );
      for (const f of [
        'ansible.cfg',
        'inventory.ini',
        'site.yml',
        'roles/push_baseline/tasks/ntp.yml',
      ])
        assert.ok(await exists(vscode.Uri.joinPath(practice, ...f.split('/'))), f);
      await until(() => /site\.yml/.test(activeTab()?.label ?? ''), 'site.yml editor');
      const r = await api.importPlaybooks({
        source: practice,
        playbooks: ['practice/site.yml'],
        keys: ['practice-site'],
      });
      assert.equal(r.error, undefined);
      assert.deepEqual(r.counts, { steps: 20, implemented: 20, drafts: 0 });
      const flow = r.uris[0] as vscode.Uri;
      await openDesigner(flow);
      const errors = api
        .diagnostics(flow)
        .filter((d) => d.severity === vscode.DiagnosticSeverity.Error);
      assert.deepEqual(
        errors.map((d) => d.message),
        [],
      );
      await closeAll();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(flow, '..'), { recursive: true });
    } finally {
      await vscode.workspace.fs.delete(practice, { recursive: true });
    }
  });

  it('Open User Guide shows a guide page in the Markdown preview, never a file outside it', async () => {
    await vscode.commands.executeCommand('afd.help.openGuide', 'how-to/subflows.md');
    await until(() => /Subflows/i.test(activeTab()?.label ?? ''), 'subflows preview');
    assert.ok(activeTab()?.input instanceof vscode.TabInputWebview, String(activeTab()?.label));
    await closeAll();
    // A path outside the guide opens the guide's index instead.
    await vscode.commands.executeCommand('afd.help.openGuide', '../../package.json');
    await until(() => /README/i.test(activeTab()?.label ?? ''), 'index preview');
  });

  it('Get Started opens the walkthrough', async () => {
    await vscode.commands.executeCommand('afd.help.getStarted');
    await until(() => /Walkthrough|Welcome|Get Started/i.test(activeTab()?.label ?? ''), 'welcome');
  });

  it('designer edits set the tour keys that check off walkthrough steps', async () => {
    const api = await testApi();
    const uri = flowUri('edge-baseline');
    await openDesigner(uri);
    const doc = parse(readFileSync(uri.fsPath, 'utf8')) as FlowDocument;
    const precheck = doc.nodes.find((n) => n.key === 'precheck');
    assert.ok(precheck);
    assert.ok((await api.run(uri, { kind: 'addNode', type: 'subflow', title: 'Tour subflow' })).ok);
    const pattern = await api.run(uri, {
      kind: 'applyPattern',
      pattern: 'exclude',
      from: { node: precheck.id, port: 'failed_hosts' },
    });
    assert.ok(pattern.ok, pattern.error);
    assert.deepEqual(api.tour().sort(), ['failureHandled', 'nodeAdded', 'subflow']);
  });

  it('AFD-201: Send Feedback opens the form with the version and editor; Report a Problem opens GitHub', async () => {
    const api = await testApi();
    await vscode.commands.executeCommand('afd.help.feedback');
    const form = new URL(api.feedback().links.at(-1) ?? '');
    assert.equal(form.origin + form.pathname, FEEDBACK_PAGE);
    const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    assert.deepEqual(Object.fromEntries(form.searchParams), {
      source: 'command',
      version,
      editor: 'vscode',
    });
    await vscode.commands.executeCommand('afd.help.reportIssue');
    assert.equal(api.feedback().links.at(-1), ISSUES_URL);
  });

  it('AFD-201: a designer showing a flow with steps counts today as a day of use', async () => {
    const api = await testApi();
    await openDesigner(flowUri('edge-baseline'));
    const today = dayOf(new Date());
    await until(() => api.feedback().state.days?.includes(today) === true, 'a day of use');
    assert.ok(api.feedback().state.first);
  });

  describe('AFD-263: an uninstall is asked about in the window, and no page opens by itself', () => {
    const ID = 'example.extension';
    const listed = JSON.stringify([{ identifier: { id: ID }, version: '1.0.0' }]);
    const win = vscode.window as unknown as Record<string, (...args: never[]) => unknown>;
    let dir: string;
    let list: string;
    let real: unknown;
    let asked: { message: string; buttons: string[] }[];
    let answer: string | undefined;
    let watch: vscode.Disposable | undefined;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'afd-uninstall-'));
      list = join(dir, 'extensions.json');
      writeFileSync(list, listed);
      asked = [];
      answer = undefined;
      real = win.showInformationMessage;
      win.showInformationMessage = (async (message: string, ...buttons: string[]) => {
        asked.push({ message, buttons });
        return answer;
      }) as never;
    });
    afterEach(() => {
      watch?.dispose();
      win.showInformationMessage = real as never;
      rmSync(dir, { recursive: true, force: true });
    });
    const settle = () => new Promise((r) => setTimeout(r, 1500));

    it('taken off the list: a polite notice; the form opens only from its button', async () => {
      const api = await testApi();
      const before = api.feedback().links.length;
      answer = 'Tell Us Why';
      watch = api.feedback().watchUninstall(list, ID);
      await settle();
      assert.equal(asked.length, 0, 'nothing is asked while it is installed');
      writeFileSync(list, '[]');
      await until(() => asked.length === 1, 'the notice');
      assert.match(asked[0]?.message ?? '', /was uninstalled\. Sorry it did not fit\./);
      assert.deepEqual(asked[0]?.buttons, ['Tell Us Why', 'No, Thanks']);
      await until(() => api.feedback().links.length === before + 1, 'the form link');
      const form = new URL(api.feedback().links.at(-1) ?? '');
      assert.equal(form.origin + form.pathname, FEEDBACK_PAGE);
      assert.equal(form.searchParams.get('source'), 'uninstall');
      // Asked once, however the list changes afterwards.
      writeFileSync(list, '[ ]');
      await settle();
      assert.equal(asked.length, 1);
    }).timeout(20_000);

    it('No, Thanks, or the notice closed: no page', async () => {
      const api = await testApi();
      const before = api.feedback().links.length;
      answer = 'No, Thanks';
      watch = api.feedback().watchUninstall(list, ID);
      await settle();
      writeFileSync(list, '[]');
      await until(() => asked.length === 1, 'the notice');
      await settle();
      assert.equal(api.feedback().links.length, before);
    }).timeout(20_000);

    it('an update (off the list for a moment, then on it again) asks nothing', async () => {
      const api = await testApi();
      watch = api.feedback().watchUninstall(list, ID);
      await settle();
      writeFileSync(list, '[]');
      setTimeout(
        () => writeFileSync(list, JSON.stringify([{ identifier: { id: ID }, version: '1.1.0' }])),
        250,
      );
      await settle();
      await settle();
      assert.equal(asked.length, 0);
    }).timeout(20_000);

    it('with the setting off, or a list that never named the extension, nothing is asked', async () => {
      const api = await testApi();
      const config = vscode.workspace.getConfiguration('afd.feedback');
      await config.update('prompt', false, vscode.ConfigurationTarget.Global);
      try {
        watch = api.feedback().watchUninstall(list, ID);
        await settle();
        writeFileSync(list, '[]');
        await settle();
        await settle();
        assert.equal(asked.length, 0);
      } finally {
        await config.update('prompt', undefined, vscode.ConfigurationTarget.Global);
      }
      watch?.dispose();
      // A development host, or a profile with its own list: not on it to begin with.
      writeFileSync(list, '[]');
      watch = api.feedback().watchUninstall(list, ID);
      await settle();
      writeFileSync(list, '[ ]');
      await settle();
      assert.equal(asked.length, 0);
    }).timeout(30_000);

    it('the marker file the uninstall script used is removed', async () => {
      const api = await testApi();
      await until(
        () => !existsSync(join(api.feedback().extensionPath, '.no-feedback')),
        'the old marker is gone',
      );
      const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
      assert.equal(manifest.scripts['vscode:uninstall'], undefined);
    });
  });
});
