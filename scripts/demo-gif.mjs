// The README's animated demos (AFD-123): takes recorded in a real VS Code with the packaged
// extension (scripts/demo-lib.mjs), encoded to media/readme/<take>.gif. Run `just package` first,
// then `just demo-gif [take…]`. Needs ffmpeg on PATH; the run take also needs an Ansible
// environment (AFD_DEMO_ENV, see below). AFD_DEMO_MP4=dir also writes an MP4 of each take there.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  command,
  encode,
  installCursor,
  launchVsCode,
  log,
  mouse,
  recorder,
  TEMP,
  wait,
  webview,
} from './demo-lib.mjs';

const OUT = process.env.AFD_DEMO_OUT ?? 'media/readme';
const SIZE = { width: 1280, height: 800 };
const only = process.argv.slice(2);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const VSIX = `out/ansible-flow-designer-${version}.vsix`;

/** The user settings of the throwaway profile: no tips, prompts or AI offers in the way. */
const SETTINGS = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.layoutControl.enabled': false,
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'window.commandCenter': false,
  'telemetry.telemetryLevel': 'off',
  'security.workspace.trust.enabled': false,
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'git.enabled': false,
  'editor.minimap.enabled': false,
};

/**
 * A workspace with the given samples, each in flows/<key>/ as Open Sample Flow… copies them, and
 * extra files at its root.
 */
function workspace(name, samples, files = {}) {
  const dir = join(TEMP, 'workspaces', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);
  for (const key of samples) {
    mkdirSync(join(dir, 'flows', key), { recursive: true });
    for (const ext of ['flow.yaml', 'scenarios.yaml']) {
      try {
        cpSync(join('samples', `${key}.${ext}`), join(dir, 'flows', key, `${key}.${ext}`));
      } catch {
        // A sample without scenarios.
      }
    }
  }
  return dir;
}

/** Opens a file by name through Quick Open. */
async function open(page, file) {
  await page.keyboard.press('Control+P');
  await wait(400);
  await page.keyboard.type(file);
  await wait(800);
  await page.keyboard.press('Enter');
  await wait(3500);
}

/** One take: a fresh VS Code, `prepare` off camera, `act` on camera, then the GIF. */
async function take(name, { samples, files, settings, prepare, act, encodeAs }) {
  const { app, page } = await launchVsCode({
    vsix: VSIX,
    workspace: workspace(name, samples, files),
    size: SIZE,
    settings: { ...SETTINGS, ...settings },
  });
  try {
    await wait(5000);
    await command(page, 'Notifications: Clear All Notifications');
    const ctx = { app, page, wv: webview(page), m: mouse(page), open: (f) => open(page, f) };
    await prepare?.(ctx);
    await installCursor(page);
    await ctx.m.place(SIZE.width - 60, SIZE.height - 60);
    const rec = await recorder(app, page, name);
    ctx.rec = rec;
    rec.start();
    await wait(600);
    try {
      await act(ctx);
    } catch (e) {
      await page.screenshot({ path: join(TEMP, `${name}-error.png`) });
      log(`${name} failed; the window is in ${join(TEMP, `${name}-error.png`)}`);
      throw e;
    }
    const frames = await rec.stop(encodeAs.holdMs ?? 2500);
    log(`${name}: ${frames.frames.length} frames`);
    mkdirSync(OUT, { recursive: true });
    const mp4Dir = process.env.AFD_DEMO_MP4;
    if (mp4Dir) mkdirSync(mp4Dir, { recursive: true });
    const crop = typeof encodeAs.crop === 'function' ? await encodeAs.crop(ctx) : encodeAs.crop;
    encode(frames, {
      ...encodeAs,
      crop: crop && {
        x: Math.round(crop.x),
        y: Math.round(crop.y),
        width: Math.round(crop.width / 2) * 2,
        height: Math.round(crop.height / 2) * 2,
      },
      gif: join(OUT, `${name}.gif`),
      mp4: mp4Dir ? join(mp4Dir, `${name}.mp4`) : undefined,
    });
  } finally {
    await app.close();
  }
}

/** A node on the canvas by its title. */
const node = (wv, title) =>
  wv.locator(`.react-flow__node:has(.afd-node-title:text-is("${title}"))`).first();

/** Clicks a menu item (port menu, context menu or submenu) by its label. */
const menuItem = (wv, label) =>
  wv.locator('[role=menuitem], [role=menuitemradio]').filter({ hasText: label }).first();

/** Off camera: no side bar, no notifications, no first-flow checklist over the canvas. */
async function tidy({ page, wv }) {
  await command(page, 'View: Close Primary Side Bar');
  await command(page, 'Notifications: Clear All Notifications');
  const hide = wv.getByText('Hide Checklist');
  if (await hide.count()) await hide.first().click();
  await wait(800);
}

/**
 * The run take's inventory: three hosts on the local connection, the third with a Python that
 * does not exist, so its ping fails for real and the run sends it to Stopped.
 */
const INVENTORY = [
  '[lab]',
  'host-01 ansible_connection=local',
  'host-02 ansible_connection=local',
  'host-03 ansible_connection=local ansible_python_interpreter=/opt/missing/bin/python3',
  '',
].join('\n');

/** Ansible for the run take: a WSL distribution with ansible-core 2.19+ (AFD_DEMO_WSL). */
const RUN_SETTINGS = {
  'afd.environment.kind': 'wsl',
  'afd.environment.wslDistro': process.env.AFD_DEMO_WSL ?? 'Debian',
  'afd.run.inventory': 'inventory.ini',
  'afd.run.askVaultPassword': 'never',
};

/** Waits until the run ends, or until VS Code shows its terminal (a run that fails a host). */
async function untilRunEnds(page, wv) {
  const done = wv.locator('.afd-run-status[data-run-state="done"]');
  const panel = page.locator('.part.panel');
  const until = Date.now() + 180_000;
  while (!(await done.isVisible()) && !(await panel.isVisible())) {
    if (Date.now() > until) throw new Error('the run did not end in 3 minutes');
    await wait(100);
  }
}

/** Off camera: the run's terminal closed and the canvas fitted again. */
async function closeRunTerminal(page, wv) {
  await wv.locator('.afd-run-status[data-run-state="done"]').waitFor({ timeout: 60_000 });
  await command(page, 'View: Close Panel');
  await command(page, 'Notifications: Clear All Notifications');
  await wv.locator('.react-flow__controls-fitview').click();
  await wait(1200);
}

/** The designer: canvas and side panel, without VS Code's title, tabs and activity bar. */
async function designerCrop({ page }) {
  return page.locator('iframe.webview.ready:visible').boundingBox();
}

/** The canvas column: the banner over it and the canvas, without the palette and side panel. */
async function canvasCrop({ page, wv }) {
  const frame = await page.locator('iframe.webview.ready:visible').boundingBox();
  const flow = await wv.locator('.react-flow').boundingBox();
  return {
    x: flow.x,
    y: frame.y + 36,
    width: flow.width,
    height: flow.y + flow.height - frame.y - 36,
  };
}

const TAKES = {
  // The README's top: add a step from a port, give its failure a rollback in one click, see the
  // play it makes, run the flow as a skeleton and see where each host went.
  hero: {
    samples: ['hello'],
    files: { 'inventory.ini': INVENTORY },
    settings: RUN_SETTINGS,
    prepare: async (ctx) => {
      await ctx.open('hello.flow.yaml');
      await tidy(ctx);
    },
    act: async ({ page, wv, m, rec }) => {
      // The design part plays a little faster than it was done.
      rec.speed(1.3);
      // Insert a step after Say hello, from its ok_hosts port.
      const say = node(wv, 'Say hello');
      await m.hoverOn(say, 700);
      await wait(300);
      await m.clickOn(say.locator('[data-port="ok_hosts"]'));
      await wait(700);
      await m.clickOn(menuItem(wv, 'Insert Node on This Wire'));
      await wait(600);
      await page.keyboard.type('Apply the baseline', { delay: 55 });
      await wait(400);
      await page.keyboard.press('Enter');
      await wait(1000);
      const fitView = async () => {
        await m.clickOn(wv.locator('.react-flow__controls-fitview'));
        await wait(1000);
      };
      await fitView();
      // Its failure: a rollback, in one click from the banner; the rollback's own failure stops.
      const banner = (label) => wv.locator('.afd-banner button').filter({ hasText: label }).first();
      await m.clickOn(banner('Rollback from Backup'));
      await wait(1500);
      await m.clickOn(banner('Stop Flow'));
      await wait(1000);
      // The new nodes went where there was room: lay the level out again.
      await m.clickOn(wv.locator('button[aria-label="More actions"]'));
      await wait(600);
      await m.clickOn(menuItem(wv, 'Tidy Up'));
      await wait(1500);
      await fitView();
      // Saved, the playbook is written: peek at the new step's play.
      await page.keyboard.press('Control+S');
      await wait(1200);
      await m.clickOn(node(wv, 'Apply the baseline'), { button: 'right' });
      await wait(700);
      await m.clickOn(menuItem(wv, 'Peek Code'));
      await wait(3200);
      await page.keyboard.press('Control+W');
      await wait(1200);
      // Nothing selected: the side panel shows the run's summary.
      const pane = await wv.locator('.react-flow__pane').boundingBox();
      await m.click(pane.x + 60, pane.y + 60);
      await wait(600);
      // A skeleton run on the lab group, in WSL.
      await m.clickOn(wv.locator('.afd-split > button').first());
      await wait(1200);
      await m.clickOn(wv.locator('.afd-launch-groups button').filter({ hasText: 'lab' }));
      await wait(700);
      await m.clickOn(wv.locator('button[data-launch-run]'));
      rec.speed(4);
      // A run that fails a host shows its terminal as it ends: cut there, then show the canvas
      // fitted, with the run's result.
      await untilRunEnds(page, wv);
      rec.cut();
      await closeRunTerminal(page, wv);
      rec.speed(1);
      await wait(900);
      // Where the failing host went.
      await m.clickOn(node(wv, 'Stopped'));
      await wait(1800);
    },
    encodeAs: { fps: 12, holdMs: 2500 },
  },

  // Handle a failure: an open fail port's menu, a pattern in one click, an existing rollback.
  failure: {
    samples: ['edge-baseline'],
    prepare: async (ctx) => {
      await ctx.open('edge-baseline.flow.yaml');
      await tidy(ctx);
    },
    act: async ({ wv, m, rec }) => {
      rec.speed(1.2);
      await m.clickOn(node(wv, 'Pre-checks').locator('[data-port="failed_hosts"]'));
      await wait(900);
      await m.hoverOn(menuItem(wv, 'Rollback (existing)'), 450);
      await wait(350);
      await m.clickOn(menuItem(wv, 'Notify On-Call and Stop'), { ms: 400 });
      await wait(1500);
      await m.clickOn(node(wv, 'Validate').locator('[data-port="failed_hosts"]'));
      await wait(900);
      await m.clickOn(menuItem(wv, 'Rollback (existing)'));
      await wait(1200);
    },
    encodeAs: { fps: 12, holdMs: 2000, crop: canvasCrop },
  },

  // Where every host went: a live skeleton run, the hosts on a wire, a failed host's result.
  run: {
    samples: ['hello'],
    files: { 'inventory.ini': INVENTORY },
    settings: RUN_SETTINGS,
    prepare: async (ctx) => {
      await ctx.open('hello.flow.yaml');
      await tidy(ctx);
    },
    act: async ({ page, wv, m, rec }) => {
      await m.clickOn(wv.locator('.afd-split > button').first());
      await wait(1000);
      await m.clickOn(wv.locator('.afd-launch-groups button').filter({ hasText: 'lab' }));
      await wait(600);
      await m.clickOn(wv.locator('button[data-launch-run]'));
      rec.speed(2.5);
      await untilRunEnds(page, wv);
      rec.cut();
      await closeRunTerminal(page, wv);
      rec.speed(1);
      await wait(700);
      // The failed host's wire, then the step it failed at.
      await m.clickOn(
        wv
          .locator('.react-flow__edge-text')
          .filter({ hasText: /^1 host$/ })
          .first(),
      );
      await wait(1800);
      await m.clickOn(node(wv, 'Check the host answers'));
      await wait(1600);
    },
    encodeAs: { fps: 12, holdMs: 2200, crop: designerCrop },
  },

  // Scenario what-if: show a scenario on the canvas, plant a failure, see the route change.
  whatif: {
    samples: ['edge-baseline'],
    prepare: async (ctx) => {
      await ctx.open('edge-baseline.flow.yaml');
      await tidy(ctx);
      // The open-ports banner is another story: out of the way, the whole flow fits.
      await ctx.wv.locator('.afd-banner button[aria-label="Dismiss"]').click();
      await wait(600);
    },
    act: async ({ wv, m, rec }) => {
      rec.speed(1.2);
      await m.clickOn(wv.locator('[data-scenario-chip]'));
      await wait(1000);
      const row = wv.locator(
        'li.afd-scenario[data-scenario="A failed push rolls back that switch only"]',
      );
      await m.clickOn(row.getByRole('button', { name: 'Show on Canvas' }));
      await wait(1200);
      await m.clickOn(wv.locator('.react-flow__controls-fitview'));
      await wait(900);
      await m.clickOn(node(wv, 'Validate'), { button: 'right' });
      await wait(700);
      await m.hoverOn(menuItem(wv, 'In "A failed push rolls back that switch only"'), 450);
      await wait(700);
      await m.clickOn(menuItem(wv, 'Fail for'));
      await wait(900);
      const pick = wv.locator('form[data-host-pick]');
      await m.clickOn(pick.locator('label.afd-check').filter({ hasText: 'sw-01' }));
      await wait(500);
      await m.clickOn(pick.locator('button[type=submit]'));
      await wait(1800);
    },
    encodeAs: { fps: 12, holdMs: 2500, crop: designerCrop },
  },
};

for (const [name, spec] of Object.entries(TAKES)) {
  if (only.length > 0 && !only.includes(name)) continue;
  log(`Take ${name}`);
  await take(name, spec);
}
