// The uninstall page (AFD-202). VS Code runs `vscode:uninstall` once, in a plain Node process at its
// next full restart after the extension was removed: no editor UI and no `vscode` API. All it can
// do is open the feedback form in the browser. It never sends anything itself.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type FeedbackEditor, feedbackUrl } from '../core/feedback/feedback';

/** Written next to the extension by Don't Ask Again or the setting turned off (src/extension/feedback.ts). */
const MARKER = '.no-feedback';

/** The editor, from the folder extensions are installed in. */
export function editorFromPath(path: string): FeedbackEditor | 'remote' {
  const p = path.replaceAll('\\', '/').toLowerCase();
  // A remote window's extension host: no browser on that machine for the person to see.
  if (/\/\.[a-z-]*-server\/|\/\.vscode-remote\//.test(p)) return 'remote';
  if (p.includes('/.cursor/')) return 'cursor';
  if (p.includes('/.kiro/')) return 'kiro';
  if (p.includes('/.windsurf/') || p.includes('/.devin/')) return 'windsurf';
  if (p.includes('antigravity')) return 'antigravity';
  if (p.includes('/.vscode-oss/')) return 'vscodium';
  if (p.includes('/.vscode/') || p.includes('/.vscode-insiders/')) return 'vscode';
  return 'other';
}

export interface UninstallEnv {
  /** The folder of the running script (dist/), inside the extension's folder. */
  dir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  exists: (path: string) => boolean;
  readText: (path: string) => string | undefined;
}

/** Why the page is not opened, or undefined to open it. */
export function skipReason(u: UninstallEnv): string | undefined {
  if (u.exists(join(u.dir, '..', MARKER))) return 'feedback turned off';
  if (u.env.CI) return 'CI';
  if (editorFromPath(u.dir) === 'remote') return 'remote';
  if (u.platform === 'linux' && !u.env.DISPLAY && !u.env.WAYLAND_DISPLAY) return 'no display';
  return undefined;
}

/** The program and arguments that open a URL in the default browser. */
export function opener(platform: NodeJS.Platform, url: string): [string, string[]] {
  if (platform === 'win32') return ['rundll32', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

/** The page to open, with the removed version and the editor. */
export function uninstallUrl(u: UninstallEnv): string {
  let version = '';
  try {
    version = String(
      JSON.parse(u.readText(join(u.dir, '..', 'package.json')) ?? '{}').version ?? '',
    );
  } catch {
    // An unreadable manifest: the page works without a version.
  }
  const editor = editorFromPath(u.dir);
  return feedbackUrl({
    source: 'uninstall',
    version,
    editor: editor === 'remote' ? 'other' : editor,
  });
}

/** What the script does: the URL it opened, or why it opened none. Never throws. */
export function runUninstall(
  u: UninstallEnv,
  spawn: (cmd: string, args: string[]) => void,
): { opened?: string; skipped?: string } {
  try {
    const skipped = skipReason(u);
    if (skipped) return { skipped };
    const url = uninstallUrl(u);
    const [cmd, args] = opener(u.platform, url);
    spawn(cmd, args);
    return { opened: url };
  } catch (e) {
    return { skipped: (e as Error).message };
  }
}

/** The real environment of the script. */
export function processEnv(dir: string): UninstallEnv {
  return {
    dir,
    platform: process.platform,
    env: process.env,
    exists: existsSync,
    readText: (path) => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}
