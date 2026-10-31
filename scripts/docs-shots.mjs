// Screenshots for the user guide and the walkthroughs (AFD-22): the webview harness (fake host,
// fixture flows) driven in the installed Edge by playwright-core, one PNG per shot and theme, and the
// extension icon rendered from its SVG. `just docs-shots [name…]`; reuses a running harness.
// The clock is fixed, so a run looks the same every time. Env: AFD_SHOTS_BROWSER (msedge | chrome).
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const PORT = 5178;
const BASE = `http://localhost:${PORT}/harness/index.html`;
const OUT = 'docs/guide/images';
const VIEWPORT = { width: 1200, height: 720 };
const only = process.argv.slice(2);

const pad = (n) => String(n).padStart(2, '0');
function log(msg) {
  const d = new Date();
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`[${t} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}] ${msg}`);
}

// ---- page helpers (run in the harness page) ------------------------------------------------------

/** Node ID by key path (`precheck/normalize`). */
const idOf = (page, path) =>
  page.evaluate((p) => {
    const doc = window.afdUi.getState().snapshot?.doc;
    let nodes = doc?.nodes ?? [];
    let found;
    for (const key of p.split('/')) {
      found = nodes.find((n) => n?.key === key);
      nodes = found?.subflow?.nodes ?? [];
    }
    if (!found) throw new Error(`no node ${p}`);
    return found.id;
  }, path);

/** Calls a webview store action. */
const ui = (page, action, ...args) =>
  page.evaluate(([a, xs]) => window.afdUi.getState()[a](...xs), [action, args]);

/** Sends a message to the harness host, as the webview does. */
const host = (page, message) =>
  page.evaluate((m) => window.acquireVsCodeApi().postMessage(m), message);

const settle = (page, ms = 600) => page.waitForTimeout(ms);

/** A port's handle on the canvas, for menus that open next to it. */
async function portBox(page, node, port) {
  const id = await idOf(page, node);
  const handle = page.locator(`.react-flow__node[data-id="${id}"] [data-port="${port}"]`).first();
  return { id, box: await handle.boundingBox() };
}

// ---- shots ---------------------------------------------------------------------------------------

/**
 * name → { flow, walk (light and dark for the walkthrough, else light only), act }. Names are the
 * files `docs/guide/images/<name>-<theme>.png` the guides and package.json refer to.
 */
const SHOTS = {
  'new-flow': { flow: 'new' },
  canvas: { flow: 'firewall-upgrade', walk: true },
  'quick-add': {
    flow: 'new',
    walk: true,
    act: async (page) => {
      const edge = await page.evaluate(() => window.afdUi.getState().snapshot.doc.edges[0].id);
      await ui(page, 'openQuickAdd', { type: 'task', insertOn: edge, title: 'Check NTP' });
    },
  },
  'context-menu': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      const id = await idOf(page, 'backup');
      await page.locator(`.react-flow__node[data-id="${id}"]`).click({ button: 'right' });
    },
  },
  'cheat-sheet': { flow: 'firewall-upgrade', act: (page) => ui(page, 'showCheatSheet', true) },
  'open-ports-banner': { flow: 'edge-baseline', walk: true },
  'port-menu': {
    flow: 'edge-baseline',
    walk: true,
    act: async (page) => {
      const { id, box } = await portBox(page, 'precheck', 'failed_hosts');
      await ui(page, 'openPortMenu', {
        ref: { node: id, port: 'failed_hosts' },
        x: Math.round(box.x + box.width + 8),
        y: Math.round(box.y),
      });
    },
  },
  'subflow-level': {
    flow: 'firewall-upgrade',
    walk: true,
    act: async (page) => ui(page, 'setLevel', await idOf(page, 'precheck')),
  },
  'extract-selection': {
    flow: 'edge-baseline',
    act: async (page) => {
      const nodes = [await idOf(page, 'backup-config'), await idOf(page, 'push-baseline')];
      await ui(page, 'select', { nodes });
    },
  },
  inspector: {
    flow: 'firewall-upgrade',
    walk: true,
    act: async (page) => ui(page, 'select', { node: await idOf(page, 'approve') }),
  },
  'properties-io': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'rollback'));
      await ui(page, 'openProperties', await idOf(page, 'rollback/restore'), 'io');
    },
  },
  'properties-binding': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'upgrade'));
      await ui(page, 'openProperties', await idOf(page, 'upgrade/wait-up'), 'implementation');
      await settle(page);
      const search = page.locator('[data-catalog-search]').first();
      await search.fill('wait for port');
      await settle(page, 900);
      await page.getByText('ansible.builtin.wait_for').first().click();
      await settle(page, 900);
    },
  },
  'properties-until': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'upgrade'));
      await ui(page, 'openProperties', await idOf(page, 'upgrade/wait-up'), 'execution');
    },
  },
  'data-lens': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await host(page, { type: 'lens', lens: 'data' });
      await ui(page, 'setLens', 'data');
    },
  },
  'inventory-lens': {
    flow: 'lens-e2e',
    act: async (page) => {
      await host(page, { type: 'lens', lens: 'inventory' });
      await ui(page, 'setLens', 'inventory');
      await settle(page, 900);
    },
  },
  'run-mode': {
    flow: 'firewall-upgrade',
    walk: true,
    act: async (page) => {
      await host(page, { type: 'run', mode: 'check' });
      await settle(page, 1200);
      await ui(page, 'setMode', 'run');
    },
  },
  implementation: {
    flow: 'edge-drift',
    act: async (page) => {
      await ui(page, 'setMode', 'implementation');
      await host(page, { type: 'sync' });
      await settle(page, 900);
    },
  },
  'awx-run': {
    flow: 'awx-e2e',
    walk: true,
    act: async (page) => {
      await host(page, { type: 'launchAwx' });
      await settle(page, 1600);
      await ui(page, 'setMode', 'run');
    },
  },
  'awx-import': { flow: 'awx-import', walk: true },
  'hand-written': { flow: 'hand-written' },
};

// ---- run -----------------------------------------------------------------------------------------

async function harnessUp() {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
}

async function startHarness() {
  if (await harnessUp()) return undefined;
  log('Starting the webview harness');
  // Vite's own script on this Node, not through npx: on Windows npx needs a shell, and killing
  // the shell would leave Vite running (and this script waiting for it).
  const vite = spawn(
    process.execPath,
    [
      'node_modules/vite/bin/vite.js',
      '--config',
      'vite.config.mts',
      '--mode',
      'harness',
      '--strictPort',
    ],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 60 && !(await harnessUp()); i++) await new Promise((r) => setTimeout(r, 500));
  if (!(await harnessUp())) throw new Error(`The harness did not start on port ${PORT}`);
  return vite;
}

async function shoot(page, name, shot, theme) {
  const url = `${BASE}?flow=${shot.flow}&theme=${theme}&shots=1`;
  await page.goto(url);
  await page.waitForFunction(() => window.afdUi?.getState().snapshot);
  await settle(page, 900);
  if (shot.act) await shot.act(page);
  await settle(page);
  const file = join(OUT, `${name}-${theme}.png`);
  await page.screenshot({ path: file });
  log(`Wrote ${file}`);
}

async function renderIcon(page) {
  const svg = readFileSync('media/icon.svg', 'utf8');
  await page.setViewportSize({ width: 128, height: 128 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace('<svg', '<svg width="128" height="128"')}</body></html>`,
  );
  await page.screenshot({ path: 'media/icon.png', omitBackground: true });
  await page.setViewportSize(VIEWPORT);
  log('Wrote media/icon.png');
}

mkdirSync(OUT, { recursive: true });
const vite = await startHarness();
const browser = await chromium.launch({ channel: process.env.AFD_SHOTS_BROWSER ?? 'msedge' });
try {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  // A fixed clock: run times and "ago" labels come out the same on every run.
  await page.clock.setFixedTime(new Date('2026-10-31T10:00:00Z'));
  if (only.length === 0 || only.includes('icon')) await renderIcon(page);
  for (const [name, shot] of Object.entries(SHOTS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    for (const theme of shot.walk ? ['light', 'dark'] : ['light'])
      await shoot(page, name, shot, theme);
  }
} finally {
  await browser.close();
  vite?.kill();
}
