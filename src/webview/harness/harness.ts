// Dev-only harness: runs the real webview against an in-page fake host that reuses src/core
// (commands, validation) and the ELK auto-layout, with a theme switcher approximating VS Code's
// default themes. `just harness`, then http://localhost:5178/harness/index.html?flow=os-upgrade
import edgeBaseline from '../../../examples/edge-baseline.flow.yaml?raw';
import osUpgrade from '../../../examples/os-upgrade.flow.yaml?raw';
import { optionA } from '../../core/engine/optionA';
import { codePreview } from '../../core/engine/preview';
import { type FlowCommand, planCommand } from '../../core/flow/commands';
import { parseFlow } from '../../core/flow/document';
import { createIdFactory } from '../../core/flow/ids';
import { buildModel, ROOT } from '../../core/flow/model';
import { openFailPorts } from '../../core/flow/openPorts';
import { validateFlow } from '../../core/flow/validate';
import type { HostMessage, Snapshot, WebviewMessage } from '../../core/protocol';
import { autoPositions, layoutLevel } from '../../extension/autoLayout';

const FLOWS: Record<string, string> = { 'edge-baseline': edgeBaseline, 'os-upgrade': osUpgrade };
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
      findings: [],
      openPorts: [],
      autoPositions: {},
    };
  }
  const { model, findings } = validateFlow(parsed.doc);
  const root = model.levels.get(ROOT);
  const preview = findings.some((f) => f.severity === 'error')
    ? undefined
    : codePreview(parsed.doc, 'harness.flow.yaml');
  return {
    docVersion: version,
    doc: parsed.doc,
    stale: false,
    findings: [...findings, ...(preview?.findings ?? [])],
    openPorts: openFailPorts(model),
    autoPositions: root ? await autoPositions(root, parsed.doc.layout) : {},
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

async function onMessage(m: WebviewMessage) {
  switch (m.type) {
    case 'ready':
      toWebview({ type: 'config', testMode: true });
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
      const root = doc ? buildModel(doc).levels.get(ROOT) : undefined;
      if (root) apply({ kind: 'tidyUp', positions: await layoutLevel(root) });
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
