// The UX baseline (AFD-33): screenshots of four flows in every mode at two window sizes, and the
// numbers wave 3 is measured against: how readable the canvas is at the zoom it opens with, how
// many wire labels it draws, what overlaps, and how often a snapshot rebuilds the flow model.
// `just ux-baseline [label]` writes docs/ux/<label>/ (default `baseline`): PNGs, metrics.json and
// metrics.md. Uses the webview harness in the installed Edge, with a fixed clock.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { host, log, openFlow, settle, startHarness, ui } from './harness-lib.mjs';

const label = process.argv[2] ?? 'baseline';
const OUT = join('docs', 'ux', label);
/** Empty, branching, subflow-heavy, imported (Tutorial 5). */
const FLOWS = ['new', 'edge-baseline', 'firewall-upgrade', 'playbook-import'];
const SIZES = [
  { width: 1280, height: 800 },
  { width: 1920, height: 1080 },
];
/** Smallest effective title size (font size × zoom) we call readable. */
const READABLE_PX = 11;

const VIEWS = {
  design: async () => {},
  code: async (page) => {
    await ui(page, 'setMode', 'implementation');
    await host(page, { type: 'sync' });
    await settle(page, 900);
  },
  run: async (page) => {
    await host(page, { type: 'run', mode: 'check' });
    await settle(page, 1200);
    await ui(page, 'setMode', 'run');
  },
  lens: async (page) => {
    await host(page, { type: 'lens', lens: 'data' });
    await ui(page, 'setLens', 'data');
  },
};

/** Canvas readability of the open level, measured in the page. */
function measure() {
  const vp = document.querySelector('.react-flow__viewport');
  const zoom = Number(/scale\(([0-9.]+)\)/.exec(vp?.style.transform ?? '')?.[1] ?? 1);
  const nodes = [...document.querySelectorAll('.react-flow__node')].filter((n) =>
    n.querySelector('.afd-node-title'),
  );
  const px = nodes
    .map((n) => Number.parseFloat(getComputedStyle(n.querySelector('.afd-node-title')).fontSize))
    .map((f) => Math.round(f * zoom * 10) / 10)
    .sort((a, b) => a - b);
  const labels = [...document.querySelectorAll('.react-flow__edge-textwrapper')].filter(
    (l) => (l.textContent ?? '').trim() !== '',
  );
  const rect = (el) => el.getBoundingClientRect();
  const hit = (a, b) =>
    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
  const pairs = (xs, ys = xs) => {
    let n = 0;
    xs.forEach((a, i) => {
      for (const [j, b] of ys.entries()) if ((xs !== ys || j > i) && hit(a, b)) n++;
    });
    return n;
  };
  const nodeRects = nodes.map(rect);
  const labelRects = labels.map(rect);
  return {
    nodes: nodes.length,
    zoom: Math.round(zoom * 100) / 100,
    titleMinPx: px[0] ?? null,
    titleMedianPx: px.length ? px[Math.floor(px.length / 2)] : null,
    readable: px.filter((p) => p >= 11).length,
    wireLabels: labels.length,
    nodeOverlaps: pairs(nodeRects),
    labelOverlaps: pairs(labelRects),
    labelsOnNodes: pairs(labelRects, nodeRects),
  };
}

/** Levels of the open flow: the top level, then every subflow with inner steps. */
const levelsOf = (page) =>
  page.evaluate(() => {
    const out = [{ id: 'root', title: 'top level' }];
    const walk = (nodes) => {
      for (const n of nodes ?? [])
        if (n?.type === 'subflow' && n.subflow?.nodes?.length) {
          out.push({ id: n.id, title: n.title });
          walk(n.subflow.nodes);
        }
    };
    walk(window.afdUi.getState().snapshot.doc.nodes);
    return out;
  });

/** Model builds in the webview for one new snapshot of the same flow. */
const buildsPerSnapshot = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const state = window.afdUi.getState();
        window.afdModelStats.builds = 0;
        // A new snapshot carries a newly parsed document, as the host sends it.
        state.setSnapshot({
          ...state.snapshot,
          doc: structuredClone(state.snapshot.doc),
          docVersion: state.snapshot.docVersion + 1,
        });
        setTimeout(() => resolve(window.afdModelStats.builds), 400);
      }),
  );

mkdirSync(OUT, { recursive: true });
const vite = await startHarness();
const browser = await chromium.launch({ channel: process.env.AFD_SHOTS_BROWSER ?? 'msedge' });
const metrics = { label, generated: new Date().toISOString(), readablePx: READABLE_PX, flows: {} };
try {
  for (const size of SIZES) {
    const page = await browser.newPage({ viewport: size, deviceScaleFactor: 1 });
    await page.clock.setFixedTime(new Date('2026-10-31T10:00:00Z'));
    for (const flow of FLOWS) {
      for (const [view, act] of Object.entries(VIEWS)) {
        await openFlow(page, flow);
        await act(page);
        await settle(page);
        const file = join(OUT, `${flow}-${view}-${size.width}.png`);
        await page.screenshot({ path: file });
        log(`Wrote ${file}`);
      }
      if (size.width !== SIZES[0].width) continue;
      // Readability per level, in Design mode at the smaller size, at the zoom each level opens with.
      await openFlow(page, flow);
      const levels = [];
      for (const level of await levelsOf(page)) {
        await ui(page, 'setLevel', level.id);
        await settle(page, 900);
        levels.push({ level: level.title, ...(await page.evaluate(measure)) });
      }
      await ui(page, 'setLevel', 'root');
      await settle(page);
      metrics.flows[flow] = { levels, buildsPerSnapshot: await buildsPerSnapshot(page) };
    }
    await page.close();
  }
} finally {
  await browser.close();
  vite?.kill();
}

writeFileSync(join(OUT, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
const rows = Object.entries(metrics.flows).flatMap(([flow, m]) =>
  m.levels.map(
    (l) =>
      `| ${flow} | ${l.level} | ${l.nodes} | ${l.zoom} | ${l.titleMinPx ?? '–'} / ${l.titleMedianPx ?? '–'} | ${l.readable}/${l.nodes} | ${l.wireLabels} | ${l.nodeOverlaps} / ${l.labelOverlaps} / ${l.labelsOnNodes} | ${m.buildsPerSnapshot} |`,
  ),
);
writeFileSync(
  join(OUT, 'metrics.md'),
  [
    `# UX metrics: ${label}`,
    '',
    `Design mode, 1280×800, each level at the zoom it opens with. Title px is the node title's font size times the zoom; readable means at least ${READABLE_PX} px. Overlaps: node/node, label/label, label on a node. Builds: flow models the webview builds for one snapshot. Generated by \`just ux-baseline ${label}\`.`,
    '',
    '| Flow | Level | Nodes | Zoom | Title px min / median | Readable | Wire labels | Overlaps n/l/l-n | Builds per snapshot |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n'),
);
log(`Wrote ${join(OUT, 'metrics.json')} and metrics.md`);
