// AFD-202: the uninstall page opens once, in the browser, with nothing sent; and not when feedback
// was turned off, in CI, on a remote server or without a display.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  editorFromPath,
  opener,
  runUninstall,
  type UninstallEnv,
} from '../../../src/uninstall/uninstall';

const EXT = 'C:\\Users\\a\\.vscode\\extensions\\chistokhinsv.ansible-flow-designer-0.77.0';
const env = (over: Partial<UninstallEnv> = {}): UninstallEnv => ({
  dir: join(EXT, 'dist'),
  platform: 'win32',
  env: {},
  exists: () => false,
  readText: (p) => (p.endsWith('package.json') ? '{"version":"0.77.0"}' : undefined),
  ...over,
});

describe('uninstall page', () => {
  it('names the editor from where extensions are installed', () => {
    expect(editorFromPath(EXT)).toBe('vscode');
    expect(editorFromPath('/home/a/.cursor/extensions/x')).toBe('cursor');
    expect(editorFromPath('/home/a/.kiro/extensions/x')).toBe('kiro');
    expect(editorFromPath('/home/a/.windsurf/extensions/x')).toBe('windsurf');
    expect(editorFromPath('C:\\Users\\a\\.antigravity\\extensions\\x')).toBe('antigravity');
    expect(editorFromPath('/home/a/.vscode-oss/extensions/x')).toBe('vscodium');
    expect(editorFromPath('/home/a/.vscode-server/extensions/x')).toBe('remote');
    expect(editorFromPath('/home/a/.cursor-server/extensions/x')).toBe('remote');
    expect(editorFromPath('/opt/editor/extensions/x')).toBe('other');
  });

  it('opens the form with the version and editor, in the default browser', () => {
    const spawned: [string, string[]][] = [];
    const r = runUninstall(env(), (cmd, args) => spawned.push([cmd, args]));
    expect(r.opened).toBe(
      'https://chistokhinsv.github.io/ansible-flow-designer/feedback/?source=uninstall&version=0.77.0&editor=vscode',
    );
    expect(spawned).toEqual([['rundll32', ['url.dll,FileProtocolHandler', r.opened]]]);
    expect(opener('darwin', 'u')).toEqual(['open', ['u']]);
    expect(opener('linux', 'u')).toEqual(['xdg-open', ['u']]);
  });

  it('opens nothing when feedback is off, in CI, remotely or without a display', () => {
    const none = (u: UninstallEnv) => {
      const spawned: string[] = [];
      const r = runUninstall(u, (cmd) => spawned.push(cmd));
      expect(spawned).toEqual([]);
      return r.skipped;
    };
    expect(none(env({ exists: (p) => p.endsWith('.no-feedback') }))).toBe('feedback turned off');
    expect(none(env({ env: { CI: 'true' } }))).toBe('CI');
    expect(none(env({ dir: '/home/a/.vscode-server/extensions/x/dist' }))).toBe('remote');
    expect(none(env({ platform: 'linux', dir: '/home/a/.vscode/extensions/x/dist' }))).toBe(
      'no display',
    );
  });

  it('never throws: an unreadable manifest opens the page without a version', () => {
    const r = runUninstall(env({ readText: () => 'not json' }), () => undefined);
    expect(r.opened).toContain('version=&editor=vscode');
    const failing = runUninstall(env(), () => {
      throw new Error('no opener');
    });
    expect(failing).toEqual({ skipped: 'no opener' });
  });
});
