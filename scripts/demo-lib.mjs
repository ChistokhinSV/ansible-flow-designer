// The recorder behind `just demo-gif` (AFD-123): the packaged extension in a real VS Code (the
// test copy in .vscode-test), a throwaway profile, frames from the Chrome DevTools screencast, a
// drawn cursor (a recording shows no system cursor), and ffmpeg to turn the frames into a GIF.
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  downloadAndUnzipVSCode,
  resolveCliArgsFromVSCodeExecutablePath,
} from '@vscode/test-electron';
import { _electron as electron } from 'playwright-core';
import { log } from './harness-lib.mjs';

export { log };
export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Where a take keeps its profile, workspace and frames (AFD_DEMO_TMP overrides). */
export const TEMP = resolve(process.env.AFD_DEMO_TMP ?? join(tmpdir(), 'afd-demo'));

/**
 * Starts VS Code with the packaged VSIX installed into a fresh profile, `settings` as the user's
 * settings, and `workspace` open. Returns the Electron app and its window.
 */
export async function launchVsCode({ vsix, workspace, settings, size, version = '1.145.2' }) {
  const exe = await downloadAndUnzipVSCode({ version, cachePath: resolve('.vscode-test') });
  const user = join(TEMP, 'user-data');
  const extensions = join(TEMP, 'extensions');
  rmSync(user, { recursive: true, force: true });
  rmSync(extensions, { recursive: true, force: true });
  mkdirSync(join(user, 'User'), { recursive: true });
  writeFileSync(join(user, 'User', 'settings.json'), JSON.stringify(settings, null, 2));
  const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
  log(`Installing ${vsix}`);
  execFileSync(
    cli,
    [
      ...cliArgs,
      `--user-data-dir=${user}`,
      `--extensions-dir=${extensions}`,
      '--install-extension',
      vsix,
    ],
    { stdio: 'ignore', shell: process.platform === 'win32' },
  );
  log('Starting VS Code');
  const app = await electron.launch({
    executablePath: exe,
    args: [
      workspace,
      `--user-data-dir=${user}`,
      `--extensions-dir=${extensions}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
    ],
  });
  const page = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }, s) => {
    const w = BrowserWindow.getAllWindows()[0];
    w.unmaximize();
    w.setContentSize(s.width, s.height);
    w.center();
  }, size);
  await page.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  return { app, page };
}

// ---- the cursor ------------------------------------------------------------------------------

/**
 * Adds a cursor and a click ripple on top of the workbench. They live in the top document, so
 * they also show over the webview's iframes. VS Code enforces Trusted Types: DOM calls only.
 */
export async function installCursor(page) {
  await page.evaluate(() => {
    const NS = 'http://www.w3.org/2000/svg';
    const cursor = document.createElement('div');
    cursor.id = 'afd-demo-cursor';
    Object.assign(cursor.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '22px',
      height: '28px',
      zIndex: '2147483647',
      pointerEvents: 'none',
      transform: 'translate(-50px, -50px)',
      filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,.6))',
    });
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '28');
    svg.setAttribute('viewBox', '0 0 16 22');
    const path = document.createElementNS(NS, 'path');
    path.setAttribute('d', 'M1 1 L1 17.5 L5.2 13.6 L8.1 20.2 L10.9 19 L8.1 12.6 L13.6 12.6 Z');
    path.setAttribute('fill', '#ffffff');
    path.setAttribute('stroke', '#000000');
    path.setAttribute('stroke-width', '1.2');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
    cursor.appendChild(svg);
    document.body.appendChild(cursor);
  });
}

const cursorAt = (page, x, y) =>
  page.evaluate(
    ([px, py]) => {
      const c = document.getElementById('afd-demo-cursor');
      if (c) c.style.transform = `translate(${px - 1}px, ${py - 1}px)`;
    },
    [x, y],
  );

const ripple = (page, x, y, right) =>
  page.evaluate(
    ([px, py, r]) => {
      const d = document.createElement('div');
      Object.assign(d.style, {
        position: 'fixed',
        left: `${px - 16}px`,
        top: `${py - 16}px`,
        width: '32px',
        height: '32px',
        borderRadius: '50%',
        zIndex: '2147483646',
        pointerEvents: 'none',
        border: '2px solid rgba(255,255,255,.9)',
        background: r ? 'rgba(255,170,60,.35)' : 'rgba(80,160,255,.35)',
        transform: 'scale(.35)',
        opacity: '1',
        transition: 'transform 380ms ease-out, opacity 380ms ease-out',
      });
      document.body.appendChild(d);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          d.style.transform = 'scale(1.25)';
          d.style.opacity = '0';
        }),
      );
      setTimeout(() => d.remove(), 450);
    },
    [x, y, right],
  );

/** A mouse that moves smoothly and shows its clicks. Coordinates are window pixels. */
export function mouse(page) {
  let at = { x: -50, y: -50 };
  const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
  const self = {
    get at() {
      return at;
    },
    async moveTo(x, y, ms = 550) {
      const from = at;
      const steps = Math.max(1, Math.round(ms / 16));
      for (let i = 1; i <= steps; i++) {
        const k = ease(i / steps);
        const p = { x: from.x + (x - from.x) * k, y: from.y + (y - from.y) * k };
        await Promise.all([page.mouse.move(p.x, p.y), cursorAt(page, p.x, p.y)]);
      }
      at = { x, y };
    },
    /** Jumps without animating (before the first visible frame). */
    async place(x, y) {
      at = { x, y };
      await Promise.all([page.mouse.move(x, y), cursorAt(page, x, y)]);
    },
    async click(x, y, { button = 'left', ms } = {}) {
      if (x !== undefined) await self.moveTo(x, y, ms);
      await ripple(page, at.x, at.y, button === 'right');
      await page.mouse.down({ button });
      await wait(70);
      await page.mouse.up({ button });
    },
    async doubleClick(x, y, opts) {
      await self.click(x, y, opts);
      await wait(60);
      await self.click(undefined, undefined);
    },
    /** Moves to the centre of a Playwright locator and clicks it. */
    async clickOn(locator, opts = {}) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`not on screen: ${locator}`);
      const dx = opts.dx ?? box.width / 2;
      const dy = opts.dy ?? box.height / 2;
      await self.click(box.x + dx, box.y + dy, opts);
    },
    async hoverOn(locator, ms) {
      const box = await locator.boundingBox();
      if (!box) throw new Error(`not on screen: ${locator}`);
      await self.moveTo(box.x + box.width / 2, box.y + box.height / 2, ms);
    },
  };
  return self;
}

// ---- frames ----------------------------------------------------------------------------------

/**
 * Records the window through the DevTools screencast: a PNG for every painted frame, with its
 * time. Frames come only when something changes, so each one lasts until the next. `speed(k)`
 * plays what follows k times faster; `cut()` drops what follows until the next `speed`.
 */
export async function recorder(app, page, name) {
  const dir = join(TEMP, 'frames', name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cdp = await app.context().newCDPSession(page);
  const frames = [];
  const speeds = [];
  const writes = [];
  let on = false;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
    if (!on) return;
    const file = join(dir, `f${String(frames.length).padStart(5, '0')}.png`);
    frames.push({ file, t: metadata.timestamp ?? Date.now() / 1000 });
    writes.push(Promise.resolve().then(() => writeFileSync(file, Buffer.from(data, 'base64'))));
  });
  await cdp.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
  return {
    start() {
      on = true;
      speeds.push({ t: Date.now() / 1000, k: 1 });
    },
    speed(k) {
      speeds.push({ t: Date.now() / 1000, k });
    },
    cut() {
      speeds.push({ t: Date.now() / 1000, k: Number.POSITIVE_INFINITY });
    },
    async stop(holdMs = 2500) {
      await wait(150);
      on = false;
      await cdp.send('Page.stopScreencast').catch(() => {});
      await Promise.all(writes);
      return { dir, frames, speeds, holdMs };
    },
  };
}

/** Each frame's playing time in seconds, after the speed marks. */
function timeline({ frames, speeds, holdMs }) {
  const factor = (t) => {
    let k = 1;
    for (const s of speeds) if (s.t <= t) k = s.k;
    return k;
  };
  const out = [];
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const next = frames[i + 1]?.t;
    const real = next === undefined ? holdMs / 1000 : Math.max(0, next - f.t);
    const k = next === undefined ? 1 : factor(f.t);
    const d = real / k;
    if (d >= 0.001) out.push({ file: f.file, d });
  }
  return out;
}

/**
 * Encodes a take with ffmpeg: a GIF (one palette for the whole take, only changed rectangles
 * stored) and, if asked, an MP4. `crop` is {x, y, width, height} in window pixels.
 */
export function encode(take, { gif, mp4, fps = 12, width, crop }) {
  const items = timeline(take);
  if (items.length === 0) throw new Error('no frames');
  const list = join(take.dir, 'frames.txt');
  const lines = items.flatMap((f) => [
    `file '${f.file.replaceAll('\\', '/')}'`,
    `duration ${f.d.toFixed(4)}`,
  ]);
  // The concat demuxer ignores the last duration unless the last file is listed again.
  lines.push(`file '${items.at(-1).file.replaceAll('\\', '/')}'`);
  writeFileSync(list, `${lines.join('\n')}\n`);
  const geometry = [
    crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : undefined,
    width ? `scale=${width}:-2:flags=lanczos` : undefined,
  ].filter(Boolean);
  const input = ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', list];
  if (gif) {
    const vf = [
      `fps=${fps}`,
      ...geometry,
      'split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle',
    ].join(',');
    execFileSync('ffmpeg', [...input, '-vf', vf, '-loop', '0', gif], { stdio: 'inherit' });
    log(`Wrote ${gif} (${(readFileSync(gif).length / 1024 / 1024).toFixed(2)} MB)`);
  }
  if (mp4) {
    const vf = ['fps=30', ...geometry].join(',');
    execFileSync(
      'ffmpeg',
      [
        ...input,
        '-vf',
        vf,
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        mp4,
      ],
      { stdio: 'inherit' },
    );
    log(`Wrote ${mp4} (${(readFileSync(mp4).length / 1024 / 1024).toFixed(2)} MB)`);
  }
}

// ---- VS Code helpers ---------------------------------------------------------------------------

/** Runs a command from the Command Palette, typed as a user types it. */
export async function command(page, label, { typeDelay = 0 } = {}) {
  await page.keyboard.press('Control+Shift+P');
  await wait(400);
  await page.keyboard.type(label, { delay: typeDelay });
  await wait(500);
  await page.keyboard.press('Enter');
  await wait(800);
}

/** The extension's webview content frame (VS Code nests it: iframe.webview, then #active-frame). */
export function webview(page) {
  return page.frameLocator('iframe.webview.ready:visible').frameLocator('#active-frame');
}
