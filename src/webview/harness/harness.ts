// Dev-only harness: runs the real webview against an in-page fake host that reuses src/core
// (commands, validation) and the ELK auto-layout, with a theme switcher approximating VS Code's
// default themes. `just harness`, then http://localhost:5178/harness/index.html?flow=os-upgrade
import edgeBaseline from '../../../examples/edge-baseline.flow.yaml?raw';
import osUpgrade from '../../../examples/os-upgrade.flow.yaml?raw';
import awxImport from '../../../test/fixtures/awx/import/edge-upgrade.flow.yaml?raw';
import awxJob from '../../../test/fixtures/awx/job-events.json';
import awxE2e from '../../../test/fixtures/awx/repo/flows/awx-e2e/awx-e2e.flow.yaml?raw';
import builtin from '../../../test/fixtures/catalog/files/ansible.builtin@2.19.4.json';
import utils from '../../../test/fixtures/catalog/files/ansible.utils@5.1.2.json';
import eos from '../../../test/fixtures/catalog/files/arista.eos@10.0.1.json';
import ios from '../../../test/fixtures/catalog/files/cisco.ios@9.0.3.json';
import edgeDrift from '../../../test/fixtures/drift/flows/edge-drift/edge-drift.flow.yaml?raw';
import driftScan from '../../../test/fixtures/drift/scan.json';
import lensFixture from '../../../test/fixtures/lens/facts.json';
import lensE2e from '../../../test/fixtures/lens/flows/lens-e2e/lens-e2e.flow.yaml?raw';
import { awxEventsToLines, playNodes } from '../../core/awx/events';
import type { AwxJobEvent } from '../../core/awx/types';
import { badgesOf, metaOf } from '../../core/catalog/rank';
import type { CatalogPlugin, CollectionFile } from '../../core/catalog/types';
import type { CodeScan } from '../../core/drift/types';
import { optionA } from '../../core/engine/optionA';
import { codePreview } from '../../core/engine/preview';
import { type FlowCommand, planCommand } from '../../core/flow/commands';
import { parseFlow } from '../../core/flow/document';
import { createIdFactory } from '../../core/flow/ids';
import { buildModel, ROOT } from '../../core/flow/model';
import { openFailPorts } from '../../core/flow/openPorts';
import { nodeDesigns } from '../../core/flow/semantic';
import { newFlowText } from '../../core/flow/template';
import { validateFlow } from '../../core/flow/validate';
import { type HistoryEntry, timingStats } from '../../core/lens/history';
import type { CodeFacts, InventoryFacts, LensId } from '../../core/lens/types';
import type { CatalogRequest, HostMessage, Snapshot, WebviewMessage } from '../../core/protocol';
import { summarizeRun } from '../../core/run/events';
import { autoPositions, layoutLevel } from '../../extension/autoLayout';

const FLOWS: Record<string, string> = {
  'edge-baseline': edgeBaseline,
  'os-upgrade': osUpgrade,
  'edge-drift': edgeDrift,
  'awx-e2e': awxE2e,
  'lens-e2e': lensE2e,
  'awx-import': awxImport,
  // AFD-16: an empty *.flow.yaml, and one that is not a flow.
  empty: '',
  broken: 'flow: [not closed\n',
};
/** Lens facts (M8) as the host would gather them for the lens-e2e fixture. */
let lensTargets = 'edge_switches';
let lensOpen: LensId | null = null;
const params = new URLSearchParams(location.search);
let text = FLOWS[params.get('flow') ?? 'edge-baseline'] ?? edgeBaseline;
let version = 1;
const undo: string[] = [];
const newId = createIdFactory();

const THEMES: Record<string, { cls: string; vars: Record<string, string> }> = {
  light: {
    cls: 'vscode-light',
    vars: {
      '--vscode-editor-background': '#ffffff',
      '--vscode-editor-foreground': '#3b3b3b',
      '--vscode-sideBar-background': '#f8f8f8',
      '--vscode-panel-border': '#e5e5e5',
      '--vscode-descriptionForeground': '#717171',
      '--vscode-focusBorder': '#005fb8',
      '--vscode-button-background': '#005fb8',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-input-background': '#ffffff',
      '--vscode-input-border': '#cecece',
    },
  },
  dark: {
    cls: 'vscode-dark',
    vars: {
      '--vscode-editor-background': '#1f1f1f',
      '--vscode-editor-foreground': '#cccccc',
      '--vscode-sideBar-background': '#181818',
      '--vscode-panel-border': '#2b2b2b',
      '--vscode-descriptionForeground': '#9d9d9d',
      '--vscode-focusBorder': '#0078d4',
      '--vscode-button-background': '#0078d4',
      '--vscode-button-foreground': '#ffffff',
      '--vscode-input-background': '#313131',
      '--vscode-input-border': '#3c3c3c',
      '--vscode-editorLineNumber-foreground': '#4a4a4a',
    },
  },
  hc: {
    cls: 'vscode-high-contrast',
    vars: {
      '--vscode-editor-background': '#000000',
      '--vscode-editor-foreground': '#ffffff',
      '--vscode-sideBar-background': '#000000',
      '--vscode-panel-border': '#6fc3df',
      '--vscode-descriptionForeground': '#ffffff',
      '--vscode-focusBorder': '#f38518',
      '--vscode-button-background': '#000000',
      '--vscode-button-border': '#6fc3df',
      '--vscode-contrastBorder': '#6fc3df',
      '--vscode-input-background': '#000000',
      '--vscode-input-border': '#6fc3df',
    },
  },
};

function setTheme(name: string) {
  const theme = THEMES[name] ?? THEMES.light;
  if (!theme) return;
  document.body.className = theme.cls;
  for (const [k, v] of Object.entries(theme.vars)) document.documentElement.style.setProperty(k, v);
  for (const t of Object.values(THEMES)) {
    for (const k of Object.keys(t.vars))
      if (!(k in theme.vars)) document.documentElement.style.removeProperty(k);
  }
}

function toWebview(m: HostMessage) {
  window.postMessage(m, '*');
}

async function snapshot(): Promise<Snapshot> {
  const parsed = parseFlow(text);
  if (!parsed.doc) {
    return {
      docVersion: version,
      doc: null,
      stale: true,
      parseError: parsed.errors[0]?.message,
      ...(parsed.errors.length === 1 && !text.replace(/#.*$/gm, '').trim() ? { empty: true } : {}),
      file: `${params.get('flow') ?? 'harness'}.flow.yaml`,
      findings: [],
      openPorts: [],
      autoPositions: {},
    };
  }
  const { model, findings } = validateFlow(parsed.doc);
  const preview = findings.some((f) => f.severity === 'error')
    ? undefined
    : codePreview(parsed.doc, 'harness.flow.yaml');
  return {
    docVersion: version,
    doc: parsed.doc,
    stale: false,
    findings: [...findings, ...(preview?.findings ?? [])],
    openPorts: openFailPorts(model),
    autoPositions: Object.assign(
      {},
      ...(await Promise.all(
        [...model.levels.values()].map((l) => autoPositions(l, parsed.doc?.layout)),
      )),
    ),
    plays: preview?.plays,
  };
}

function apply(input: FlowCommand): { ok: boolean; error?: string; created?: string } {
  const cmd = input.kind === 'setDecision' && !input.by ? { ...input, by: 'harness-user' } : input;
  try {
    const r = planCommand(text, cmd, { newId });
    if (r.edits.length > 0) {
      undo.push(text);
      text = r.text;
      version++;
    }
    return { ok: true, created: r.created };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

// No SQLite in a browser: the harness catalog is the test fixture with word matching.
const PLUGINS = ([builtin, ios, eos, utils] as unknown as CollectionFile[]).flatMap(
  (f) => f.plugins,
);
const CTX = { collections: ['cisco.ios', 'ansible.utils'], platforms: ['cisco.ios'] };

function catalogAnswer(r: CatalogRequest): unknown {
  switch (r.op) {
    case 'search': {
      const words = r.query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 2);
      return PLUGINS.filter((p) => !r.types || r.types.includes(p.type))
        .map((p) => {
          const hay = `${p.fqcn} ${p.short_description} ${p.description}`.toLowerCase();
          return { p, score: words.filter((w) => hay.includes(w)).length };
        })
        .filter((x) => x.score > 0 || words.length === 0)
        .sort((a, b) => b.score - a.score)
        .map(({ p, score }) => {
          const badges = badgesOf(p, metaOf(p), CTX);
          return {
            fqcn: p.fqcn,
            type: p.type,
            collection: p.collection,
            short_description: p.short_description,
            score,
            match: '',
            badges,
            dimmed: badges.includes('other-platform'),
          };
        });
    }
    case 'doc': {
      const p = PLUGINS.find((x) => x.fqcn === r.fqcn) as CatalogPlugin | undefined;
      const file = ([builtin, ios, eos, utils] as unknown as CollectionFile[]).find(
        (f) => f.collection === p?.collection,
      );
      return p ? { ...p, collection_version: file?.version } : null;
    }
    case 'roles':
      return [
        {
          name: 'ios_upgrade',
          path: 'roles/ios_upgrade',
          tasks: ['main', 'stage', 'reload'],
          entry_points: {
            main: {
              short_description: 'Upgrade IOS images',
              description: '',
              options: { image: { type: 'str', description: 'Image file name', required: true } },
            },
          },
        },
        { name: 'notify', path: 'roles/notify', tasks: ['main'], entry_points: {} },
      ];
    case 'playbooks':
      return [
        {
          path: 'playbooks/backup.yml',
          plays: [{ name: 'Back up configs', hosts: '{{ afd_hosts }}' }],
        },
      ];
    default:
      return { state: 'ready' };
  }
}

// No probe in a browser: Re-sync answers with the drift fixture's real scan (M6).
function fakeScan(): CodeScan {
  return {
    at: new Date().toISOString(),
    environment: 'harness (scan fixture)',
    git: {
      branch: 'main',
      commit: '4f2c1a9',
      when: new Date(Date.now() - 5 * 60_000).toISOString(),
      dirty: [],
    },
    ...(driftScan as unknown as Omit<CodeScan, 'at' | 'environment' | 'git'>),
  };
}

async function onMessage(m: WebviewMessage) {
  switch (m.type) {
    case 'sync':
      toWebview({ type: 'sync', state: 'syncing' });
      setTimeout(() => toWebview({ type: 'sync', state: 'done', scan: fakeScan() }), 300);
      break;
    case 'driftAction':
      console.info('[host] drift action', m.action);
      toWebview({ type: 'ack', reqId: m.reqId, ok: true });
      break;
    case 'catalog':
      setTimeout(
        () =>
          toWebview({
            type: 'catalogReply',
            reqId: m.reqId,
            ok: true,
            result: catalogAnswer(m.request),
          }),
        60,
      );
      break;
    case 'ready':
      toWebview({ type: 'config', testMode: true });
      toWebview({
        type: 'catalogStatus',
        status: { state: 'ready', environment: 'harness fixture', platforms: CTX.platforms },
      });
      toWebview({ type: 'snapshot', snapshot: await snapshot() });
      break;
    case 'initFlow':
      undo.push(text);
      text = newFlowText('Empty', 'empty', createIdFactory());
      version++;
      toWebview({ type: 'snapshot', snapshot: await snapshot() });
      break;
    case 'command': {
      const result = apply(m.command);
      toWebview({ type: 'ack', reqId: m.reqId, ...result });
      toWebview({ type: 'snapshot', snapshot: await snapshot() });
      break;
    }
    case 'tidyUp': {
      const doc = parseFlow(text).doc;
      const level = doc ? buildModel(doc).levels.get(m.level ?? ROOT) : undefined;
      if (level) apply({ kind: 'tidyUp', positions: await layoutLevel(level) });
      toWebview({ type: 'snapshot', snapshot: await snapshot() });
      break;
    }
    case 'run': {
      // No Ansible in a browser: fake a happy-path run so the run UI can be looked at.
      const doc = parseFlow(text).doc;
      if (!doc) break;
      const startedAt = new Date().toISOString();
      const base = { id: 'harness', mode: m.mode, startedAt, environment: 'harness (fake)' };
      toWebview({ type: 'run', run: { ...base, state: 'running' } });
      const { routes } = optionA.generate(doc, { source: 'harness.flow.yaml' });
      const hosts = ['sw-edge-01', 'sw-edge-02'];
      const nodes: Record<string, Record<string, string[]>> = {};
      for (const r of Object.values(routes))
        if (/^(ok_hosts|true|approved|branch_\d+)$/.test(r.port))
          nodes[r.node] = { ...nodes[r.node], [r.port]: hosts };
      setTimeout(() => {
        const summary = {
          nodes,
          outcome: {},
          failures: [],
          unreachable: [],
          hosts,
          stoppedEarly: false,
        };
        toWebview({ type: 'run', run: { ...base, state: 'done', rc: 0, summary } });
      }, 800);
      break;
    }
    case 'launchAwx': {
      // Replays the lab's real AWX job of awx-e2e (test/fixtures/awx) for Run mode checks.
      const doc = parseFlow(text).doc;
      if (!doc) break;
      const { routes } = optionA.generate(doc, { source: 'harness.flow.yaml' });
      const summary = summarizeRun(
        awxEventsToLines(awxJob.events as AwxJobEvent[], playNodes(doc)),
        routes,
      );
      const awx = {
        jobId: awxJob.job.id,
        url: `https://awx.example.net/#/jobs/playbook/${awxJob.job.id}/output`,
        template: `AFD · ${doc.flow.key}`,
        status: 'running',
        revision: awxJob.job.scm_revision,
        revisionMismatch: true,
      };
      const base = {
        id: 'harness-awx',
        mode: 'real' as const,
        startedAt: awxJob.job.started,
        source: 'awx' as const,
        flowVersion: doc.flow.version,
        design: nodeDesigns(doc),
        environment: `AWX: ${awx.template}`,
      };
      toWebview({ type: 'run', run: { ...base, state: 'running', awx } });
      setTimeout(() => {
        const done = { ...awx, status: awxJob.job.status };
        const finishedAt = awxJob.job.finished ?? undefined;
        toWebview({
          type: 'run',
          run: { ...base, state: 'done', rc: 2, finishedAt, awx: done, summary },
        });
      }, 1200);
      break;
    }
    case 'lens': {
      lensOpen = m.lens;
      if (!m.lens) break;
      toWebview({
        type: 'lensFacts',
        facts: {
          code: lensFixture.code as unknown as CodeFacts,
          timing: timingStats(lensFixture.history as HistoryEntry[]),
        },
      });
      if (m.lens === 'inventory' || m.lens === 'access') {
        toWebview({
          type: 'lensFacts',
          facts: { inventory: { state: 'loading', targets: lensTargets } },
        });
        setTimeout(() => {
          const facts = { ...(lensFixture.inventory as InventoryFacts), targets: lensTargets };
          toWebview({
            type: 'lensFacts',
            facts: { inventory: { state: 'ready', facts, targets: lensTargets } },
          });
        }, 400);
      }
      break;
    }
    case 'setTargets': {
      const t = window.prompt('Flow targets', lensTargets);
      if (t) lensTargets = t;
      void onMessage({ type: 'lens', lens: lensOpen, refresh: true });
      break;
    }
    case 'perf':
      console.info(`[perf] ${m.event} v${m.docVersion}: ${m.ms.toFixed(1)} ms`);
      break;
    case 'cspViolation':
      console.warn('[csp]', m.detail);
      break;
    default:
      console.info('[host]', m);
  }
}

let state: unknown;
(window as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage: (m: WebviewMessage) => void onMessage(m),
  getState: () => state,
  setState: (s: unknown) => {
    state = s;
  },
});

window.addEventListener('keydown', async (e) => {
  if (
    (e.ctrlKey || e.metaKey) &&
    e.key === 'z' &&
    undo.length > 0 &&
    !(e.target instanceof HTMLInputElement)
  ) {
    text = undo.pop() ?? text;
    version++;
    toWebview({ type: 'snapshot', snapshot: await snapshot() });
  }
});

const bar = document.createElement('div');
bar.style.cssText =
  'position:fixed;right:330px;bottom:8px;z-index:50;display:flex;gap:4px;font:12px sans-serif';
for (const name of Object.keys(THEMES)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.dataset.theme = name;
  b.onclick = () => setTheme(name);
  bar.append(b);
}
document.body.append(bar);
setTheme(params.get('theme') ?? 'light');
(window as unknown as { afdText: () => string }).afdText = () => text;

await import('../main');
// The webview store, so the browser pane can set what a pointer cannot (a group selection).
(window as unknown as { afdUi: unknown }).afdUi = (await import('../store')).useUi;
