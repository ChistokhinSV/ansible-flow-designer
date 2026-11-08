// AFD-174: an editor's built-in agent after the user's consent, into a temporary home: the MCP
// entry and the skill where that agent reads them (checked in the editors, AFD-172), then nothing
// more on the next start; Devin gets no second entry when Claude Code already registers the tools.
import * as assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { testApi } from './helpers';

describe('AFD-174: the agent built into the editor', () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'afd-host-'));
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  it('Kiro: its MCP file and skill folder, once', async () => {
    const api = await testApi();
    const { written, again } = await api.hostAi('kiro', home);
    const mcp = join(home, '.kiro', 'settings', 'mcp.json');
    assert.deepEqual(written.sort(), [mcp, join(home, '.kiro', 'skills', 'ansible-flow')].sort());
    assert.deepEqual(again, []);
    const entry = JSON.parse(readFileSync(mcp, 'utf8')).mcpServers['ansible-flow'];
    assert.ok(entry.command && entry.args[0].endsWith('mcp.js'), JSON.stringify(entry));
    assert.ok(existsSync(join(home, '.kiro', 'skills', 'ansible-flow', 'SKILL.md')));
  });

  it('Antigravity IDE: its global customization root', async () => {
    const { written } = await (await testApi()).hostAi('antigravity', home);
    assert.ok(written.includes(join(home, '.gemini', 'config', 'mcp_config.json')));
    assert.ok(written.includes(join(home, '.gemini', 'config', 'skills', 'ansible-flow')));
  });

  it('Devin: no second entry when Claude Code has the tools; the skill in its own folder', async () => {
    writeFileSync(
      join(home, '.claude.json'),
      JSON.stringify({ mcpServers: { 'ansible-flow': { command: 'node', args: ['mcp.js'] } } }),
    );
    const { written } = await (await testApi()).hostAi('windsurf', home);
    assert.deepEqual(written, [join(home, '.codeium', 'windsurf', 'skills', 'ansible-flow')]);
  });
});
