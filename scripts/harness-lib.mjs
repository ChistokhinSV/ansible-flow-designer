// Shared by the scripts that drive the webview harness in a real browser (AFD-22 screenshots,
// AFD-33 UX baseline): starting the harness, the log line format and page helpers.
import { spawn } from 'node:child_process';

export const PORT = 5178;
export const BASE = `http://localhost:${PORT}/harness/index.html`;

const pad = (n) => String(n).padStart(2, '0');
export function log(msg) {
  const d = new Date();
  const t = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  console.log(`[${t} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}] ${msg}`);
}

/** Node ID by key path (`precheck/normalize`). */
export const idOf = (page, path) =>
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
export const ui = (page, action, ...args) =>
  page.evaluate(([a, xs]) => window.afdUi.getState()[a](...xs), [action, args]);

/** Sends a message to the harness host, as the webview does. */
export const host = (page, message) =>
  page.evaluate((m) => window.acquireVsCodeApi().postMessage(m), message);

export const settle = (page, ms = 600) => page.waitForTimeout(ms);

async function harnessUp() {
  try {
    return (await fetch(BASE)).ok;
  } catch {
    return false;
  }
}

/** Starts the harness unless one is running; returns the process to kill afterwards. */
export async function startHarness() {
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

/** Opens a harness flow with screenshots on (no harness controls) and waits for it. */
export async function openFlow(page, flow, theme = 'light') {
  await page.goto(`${BASE}?flow=${flow}&theme=${theme}&shots=1`);
  await page.waitForFunction(() => window.afdUi?.getState().snapshot);
  await settle(page, 900);
}
