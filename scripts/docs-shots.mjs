// Screenshots for the user guide and the walkthroughs (AFD-22): the webview harness (fake host,
// fixture flows) driven in the installed Edge by playwright-core, one PNG per shot and theme, and the
// extension icon rendered from its SVG. `just docs-shots [name…]`; reuses a running harness.
// The clock is fixed, so a run looks the same every time. Env: AFD_SHOTS_BROWSER (msedge | chrome).
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { host, idOf, log, openFlow, settle, startHarness, ui } from './harness-lib.mjs';

const OUT = 'docs/guide/images';
const VIEWPORT = { width: 1200, height: 720 };
const only = process.argv.slice(2);

// ---- page helpers (run in the harness page) ------------------------------------------------------

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
  // AFD-74: the Hello sample, for the README and How flows work.
  hello: { flow: 'hello' },
  'quick-add': {
    flow: 'new',
    walk: true,
    act: async (page) => {
      const edge = await page.evaluate(() => window.afdUi.getState().snapshot.doc.edges[0].id);
      await ui(page, 'openQuickAdd', { type: 'task', insertOn: edge, title: 'Check NTP' });
    },
  },
  // AFD-73: the first-flow checklist on a flow with its first step; the playbook seen already.
  'first-flow': {
    flow: 'new',
    act: async (page) => {
      await ui(page, 'setFirstFlow', { hidden: false, done: ['codeSeen'] });
      const edge = await page.evaluate(() => window.afdUi.getState().snapshot.doc.edges[0].id);
      const command = { kind: 'addNode', type: 'task', title: 'Check NTP', insertOn: edge };
      await host(page, { type: 'command', reqId: 950, command });
      await settle(page, 900);
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
  'open-ports-banner': { flow: 'edge-baseline' },
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
    act: async (page) => ui(page, 'setLevel', await idOf(page, 'precheck')),
  },
  // AFD-60: os-upgrade's Upgrade OS subflow inserted in edge-baseline as a shared copy, wired before
  // Done; its level. The source is upgraded to format 2 first, as the extension does (AFD-62).
  'shared-subflow': {
    flow: 'os-upgrade',
    act: async (page) => {
      const command = (reqId, c) => host(page, { type: 'command', reqId, command: c });
      await command(910, { kind: 'upgradeFormat' });
      await settle(page, 1500);
      const source = await page.evaluate(() =>
        window.afdUi.getState().snapshot.doc.nodes.find((n) => n.key === 'upgrade-os'),
      );
      const version = await page.evaluate(() => window.afdUi.getState().snapshot.doc.flow.version);
      await openFlow(page, 'edge-baseline');
      await command(911, { kind: 'upgradeFormat' });
      await command(912, {
        kind: 'addReference',
        from: '../os-upgrade/os-upgrade.flow.yaml#upgrade-os',
        version,
        source,
      });
      // The harness lays the new level out before it sends the snapshot.
      await settle(page, 2500);
      const copy = await idOf(page, 'upgrade-os');
      const done = await idOf(page, 'done');
      const wire = await page.evaluate(
        (d) =>
          window.afdUi
            .getState()
            .snapshot.doc.edges.find((e) => e.to.node === d && e.from.port === 'ok_hosts').id,
        done,
      );
      await command(913, { kind: 'rewire', edge: wire, to: { node: copy, port: 'in' } });
      await command(914, {
        kind: 'connect',
        from: { node: copy, port: 'ok_hosts' },
        to: { node: done, port: 'in' },
      });
      await settle(page, 1500);
      await ui(page, 'setLevel', copy);
      await settle(page, 600);
    },
  },
  'extract-selection': {
    flow: 'edge-baseline',
    act: async (page) => {
      const nodes = [await idOf(page, 'backup-config'), await idOf(page, 'push-baseline')];
      await ui(page, 'select', { nodes });
    },
  },
  details: {
    flow: 'firewall-upgrade',
    walk: true,
    act: async (page) => ui(page, 'select', { node: await idOf(page, 'approve') }),
  },
  'properties-io': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'rollback'));
      await ui(page, 'openDetails', await idOf(page, 'rollback/restore'), 'io');
    },
  },
  'properties-binding': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'upgrade'));
      await ui(page, 'openDetails', await idOf(page, 'upgrade/wait-up'), 'binding');
      // Expanded, the Binding tab lays out find, docs and configure side by side (AFD-43).
      await ui(page, 'setExpanded', true);
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
      await ui(page, 'openDetails', await idOf(page, 'upgrade/wait-up'), 'execution');
      // The polling settings are in the Timing group (AFD-44).
      await settle(page);
      await page.locator('[data-setting-group="Timing"]').scrollIntoViewIfNeeded();
    },
  },
  // AFD-112: a step's Retries asked at run time, with its note and the Timing sentence.
  'timing-run-time': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'upgrade'));
      const id = await idOf(page, 'upgrade/wait-up');
      const command = {
        kind: 'askAtRunTime',
        id,
        setting: 'retries',
        name: 'wait_tries',
        description: 'How many more times to check that the firewall is back',
        default: 40,
      };
      await host(page, { type: 'command', reqId: 960, command });
      await settle(page, 900);
      await ui(page, 'openDetails', id, 'execution');
      await settle(page);
      await page.locator('[data-timing-field="retries"]').scrollIntoViewIfNeeded();
    },
  },
  'data-lens': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      await host(page, { type: 'lens', lens: 'data' });
      await ui(page, 'setLens', 'data');
    },
  },
  'changes-lens': {
    flow: 'firewall-upgrade',
    act: async (page) => {
      const command = (reqId, c) => host(page, { type: 'command', reqId, command: c });
      await command(901, {
        kind: 'updateNode',
        id: await idOf(page, 'approve'),
        patch: { title: 'CAB approval', intent: 'The change advisory board approves the window.' },
      });
      await command(902, { kind: 'deleteNodes', ids: [await idOf(page, 'notify')] });
      await settle(page);
      await host(page, { type: 'lens', lens: 'changes' });
      await ui(page, 'setLens', 'changes');
      await ui(page, 'openDetails', await idOf(page, 'approve'));
      await settle(page, 600);
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
      await ui(page, 'setMode', 'code');
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
  // AFD-28: the sample playbooks imported as is: the baseline play, and a looped step's keywords.
  'playbook-import': {
    flow: 'playbook-import',
    act: async (page) => ui(page, 'setLevel', await idOf(page, 'baseline/edge-baseline')),
  },
  'task-keywords': {
    flow: 'playbook-import',
    act: async (page) => {
      await ui(page, 'setLevel', await idOf(page, 'baseline/edge-baseline/push-the-baseline'));
      await ui(
        page,
        'openDetails',
        await idOf(page, 'baseline/edge-baseline/push-the-baseline/configure-the-uplinks'),
        'execution',
      );
    },
  },
  'hand-written': { flow: 'hand-written' },
  // AFD-65: notes (one on a node), a section and text; a note selected shows its panel.
  annotations: {
    flow: 'annotated',
    act: async (page) => {
      const id = await page.evaluate(
        () => window.afdUi.getState().snapshot.doc.annotations.find((a) => a.key === 'note-1').id,
      );
      await ui(page, 'select', { annotations: [id] });
      await settle(page, 600);
    },
  },
};

// ---- run -----------------------------------------------------------------------------------------

async function shoot(page, name, shot, theme) {
  await openFlow(page, shot.flow, theme);
  if (shot.act) await shot.act(page);
  await settle(page);
  const file = join(OUT, `${name}-${theme}.png`);
  await page.screenshot({ path: file });
  log(`Wrote ${file}`);
}

// AFD-113: the icon set (media/icon.svg, media/icon.png at 256 px) comes from the designer; this
// renders the PNG again from the SVG only when asked by name (`just docs-shots icon`).
async function renderIcon(page) {
  const svg = readFileSync('media/icon.svg', 'utf8');
  await page.setViewportSize({ width: 256, height: 256 });
  await page.setContent(
    `<html><body style="margin:0;background:transparent">${svg.replace(/<svg([^>]*?) width="\d+" height="\d+"/, '<svg$1 width="256" height="256"')}</body></html>`,
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
  if (only.includes('icon')) await renderIcon(page);
  for (const [name, shot] of Object.entries(SHOTS)) {
    if (only.length > 0 && !only.includes(name)) continue;
    for (const theme of shot.walk ? ['light', 'dark'] : ['light'])
      await shoot(page, name, shot, theme);
  }
} finally {
  await browser.close();
  vite?.kill();
}
