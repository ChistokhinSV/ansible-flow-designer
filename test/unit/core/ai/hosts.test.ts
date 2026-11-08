// AFD-172: which editor the extension runs in, and where its agent reads MCP servers and skills.
import { describe, expect, it } from 'vitest';
import { detectHost, HOSTS } from '../../../../src/node/ai/hosts';

describe('detectHost', () => {
  it.each([
    [{ appName: 'Visual Studio Code', uriScheme: 'vscode' }, 'vscode'],
    [{ appName: 'Visual Studio Code - Insiders', uriScheme: 'vscode-insiders' }, 'vscode'],
    [{ appName: 'VSCodium', uriScheme: 'vscodium' }, 'vscode'],
    [{ appName: 'Cursor', uriScheme: 'cursor' }, 'cursor'],
    [{ appName: 'Antigravity IDE', uriScheme: 'antigravity-ide' }, 'antigravity'],
    [{ appName: 'Devin', uriScheme: 'devin' }, 'windsurf'],
    [{ appName: 'Windsurf', uriScheme: 'windsurf' }, 'windsurf'],
    [{ appName: 'Kiro', uriScheme: 'kiro' }, 'kiro'],
    [{ appName: 'Trae', uriScheme: 'trae' }, 'other'],
  ])('%o is %s', (app, id) => {
    expect(detectHost(app)).toBe(id);
  });
});

describe('HOSTS paths', () => {
  it('puts Devin MCP where Devin reads it on each platform', () => {
    const win = HOSTS.windsurf.mcp({ home: 'C:\\Users\\u', platform: 'win32' });
    expect(win[0]).toMatch(/AppData[\\/]Roaming[\\/]devin[\\/]mcp_config\.json$/);
    const linux = HOSTS.windsurf.mcp({ home: '/home/u', platform: 'linux' });
    expect(linux[0]?.replaceAll('\\', '/')).toBe('/home/u/.config/devin/mcp_config.json');
    const xdg = HOSTS.windsurf.mcp({ home: '/home/u', platform: 'linux', xdgConfig: '/cfg' });
    expect(xdg[0]?.replaceAll('\\', '/')).toBe('/cfg/devin/mcp_config.json');
  });

  it('gives every fork an MCP file and a skill folder', () => {
    const env = { home: '/h', platform: 'linux' as const };
    for (const id of ['cursor', 'antigravity', 'windsurf', 'kiro'] as const) {
      expect(HOSTS[id].mcp(env).length, id).toBeGreaterThan(0);
      expect(HOSTS[id].skills(env).length, id).toBeGreaterThan(0);
    }
  });
});
