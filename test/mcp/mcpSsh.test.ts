// AFD-252: flow_scenarios verify through the MCP server with an SSH environment (AFD-247), against
// a real host. Skipped unless AFD_SSH_HOST names one (an alias of your SSH config):
//   just build-prod; AFD_MCP=1 AFD_SSH_HOST=gns3 npx vitest run --project mcp test/mcp/mcpSsh.test.ts
// With AFD_SSH_IMAGE the scenarios run in that image on the host; without it, with the
// ansible-playbook on the account's PATH. The server reads the environment from the user settings
// (AFD_USER_SETTINGS names the file here), and from the workspace's only with the opt-in (AFD-126).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../..');
const HOST = process.env.AFD_SSH_HOST ?? '';
const IMAGE = process.env.AFD_SSH_IMAGE ?? '';
const DIR = `.afd/test-mcp-${process.pid}`;
const FLOW = 'flows/hello/hello.flow.yaml';
const SCENARIOS = 'flows/hello/hello.scenarios.yaml';
const SSH = {
  'afd.environment.kind': 'ssh',
  'afd.environment.sshHost': HOST,
  'afd.environment.sshDir': DIR,
  ...(IMAGE ? { 'afd.environment.image': IMAGE } : {}),
};

let repo: string;
let home: string;
const clients: Client[] = [];

/** The server as an agent starts it, with these user settings and environment. */
async function server(user: Record<string, unknown>, env: Record<string, string> = {}) {
  const settings = join(home, `settings-${clients.length}.json`);
  writeFileSync(settings, JSON.stringify(user));
  const client = new Client({ name: 'afd-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'dist/mcp.js')],
      cwd: repo,
      stderr: 'pipe',
      env: { ...process.env, AFD_USER_SETTINGS: settings, ...env } as Record<string, string>,
    }),
  );
  clients.push(client);
  return async (args: Record<string, unknown>) => {
    const r = (await client.callTool(
      { name: 'flow_scenarios', arguments: { path: FLOW, ...args } },
      undefined,
      { timeout: 300_000 },
    )) as { content: { type: string; text: string }[]; isError?: boolean };
    return { text: r.content.map((c) => c.text).join('\n'), isError: r.isError === true };
  };
}

const onHost = (script: string) =>
  execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', HOST, script], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();

describe.skipIf(!HOST)(
  `MCP flow_scenarios verify on the SSH host ${HOST || '(AFD_SSH_HOST)'}`,
  () => {
    beforeAll(() => {
      repo = mkdtempSync(join(tmpdir(), 'afd-mcp-ssh-'));
      home = mkdtempSync(join(tmpdir(), 'afd-mcp-home-'));
      mkdirSync(join(repo, 'flows/hello'), { recursive: true });
      cpSync(join(ROOT, 'samples/hello.flow.yaml'), join(repo, FLOW));
      cpSync(join(ROOT, 'samples/hello.scenarios.yaml'), join(repo, SCENARIOS));
      const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
      git('init', '-q');
      git('config', 'user.name', 'Test Author');
      git('config', 'user.email', 'author@example.net');
      git('add', '.');
      git('commit', '-qm', 'flow');
    });

    afterAll(async () => {
      for (const c of clients) await c.close();
      rmSync(repo, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      if (HOST) onHost(`rm -rf "$HOME/${DIR}"`);
    });

    it('runs the scenarios on the host named in the user settings and reports each', async () => {
      const scenarios = await server(SSH);
      const all = await scenarios({ action: 'verify' });
      expect(all.text).toContain('2 of 2 pass in Ansible');
      expect(all.isError).toBe(false);
      // The repository was copied to the folder the settings name, and nowhere else.
      expect(onHost(`ls "$HOME/${DIR}"`)).toContain('repo');

      const one = await scenarios({ action: 'verify', names: ['Every host says hello'] });
      expect(one.text).toContain('1 of 1 pass in Ansible');
    }, 400_000);

    it('a scenario whose expectation Ansible does not meet is reported as failing, with the host', async () => {
      const before = readFileSync(join(repo, SCENARIOS), 'utf8');
      // host-02 fails at ping and stops; the scenario now claims it ends at done.
      const wrong = before.replace('      host-02: stopped', '      host-02: done');
      expect(wrong).not.toBe(before);
      writeFileSync(join(repo, SCENARIOS), wrong);
      try {
        const scenarios = await server(SSH);
        // The simulation disagrees too, which is a warning, not a block: Ansible decides.
        const r = await scenarios({ action: 'verify' });
        expect(r.text).toContain('1 of 2 pass in Ansible');
        expect(r.text).toMatch(/host-02/);
      } finally {
        writeFileSync(join(repo, SCENARIOS), before);
      }
    }, 400_000);

    it('an SSH host only the workspace names is used with the opt-in, and named in the refusal without', async () => {
      mkdirSync(join(repo, '.vscode'), { recursive: true });
      writeFileSync(join(repo, '.vscode/settings.json'), JSON.stringify(SSH));
      try {
        const plain = await (await server({}))({ action: 'verify' });
        expect(plain.isError).toBe(true);
        expect(plain.text).toContain('AFD_MCP_WORKSPACE_ENVIRONMENT=1');

        const allowed = await (await server({}, { AFD_MCP_WORKSPACE_ENVIRONMENT: '1' }))({
          action: 'verify',
          names: ['Every host says hello'],
        });
        expect(allowed.text).toContain('1 of 1 pass in Ansible');
      } finally {
        rmSync(join(repo, '.vscode'), { recursive: true, force: true });
      }
    }, 400_000);
  },
);
