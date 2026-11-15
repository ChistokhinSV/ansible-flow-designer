// AFD-293: a step bound to a role becomes a subflow of the role's work (a step per task file, or a
// copy of each task with its handlers, defaults and files), and back while it is as it was made.
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyOps } from '../../../src/core/ai/ops';
import { optionA } from '../../../src/core/engine/optionA';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import { CommandError, planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, modelOf, ROOT } from '../../../src/core/flow/model';
import { handlersNotifiedBy } from '../../../src/core/flow/notify';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { expandRoleSource, roleFiles, roleFingerprint } from '../../../src/core/import/expandRole';
import { roleFindings } from '../../../src/node/roleRefs';
import { fsSource } from './helpers';

const REPO = join(__dirname, '../../fixtures/expand-role');
const io = fsSource(REPO);

const ID = (n: number) => `01M6GPM979RJPCDJ0XFF22G${String(n).padStart(3, '0')}`.replace(/0/g, 'B');
/** start -> <role step> -> done, the failures of the step to a failed end. */
function flow(role: string, extra = '') {
  return `schema_version: 2
flow:
  id: 01M6GPM95NZM7QW2BDFB073CNN
  key: site
  name: Site
  version: 1
  inputs:
    devices: {type: host_list, required: true, targets: true}
nodes:
- {id: ${ID(1)}, key: start, type: start, title: Start}
- id: ${ID(2)}
  key: ${role}
  type: task
  title: Set up ${role}
  impl: {kind: role, ref: ${role}${extra}}
- {id: ${ID(3)}, key: done, type: end, title: Done, outcome: success}
- {id: ${ID(4)}, key: failed, type: end, title: Failed, outcome: failed}
edges:
- {id: ${ID(11)}, from: {node: ${ID(1)}, port: ok_hosts}, to: {node: ${ID(2)}, port: in}}
- {id: ${ID(12)}, from: {node: ${ID(2)}, port: ok_hosts}, to: {node: ${ID(3)}, port: in}}
- {id: ${ID(13)}, from: {node: ${ID(2)}, port: failed_hosts}, to: {node: ${ID(4)}, port: in}}
`;
}

const docOf = (text: string): FlowDocument => {
  const doc = parseFlow(text).doc;
  if (!doc) throw new Error('does not parse');
  return doc;
};
const nodeOf = (doc: FlowDocument, key: string) =>
  [...modelOf(doc).nodes.values()].find((e) => e.node.key === key)?.node as FlowNode;

async function expanded(text: string, key: string) {
  const step = nodeOf(docOf(text), key);
  const was = step.expanded_from;
  const read = await expandRoleSource(
    io,
    { key, impl: was ? was.step.impl : step.impl },
    createIdFactory(),
  );
  if (!read.source || !read.expanded) throw new Error(read.error);
  const r = planCommand(
    text,
    { kind: 'expandRole', id: step.id, source: read.source, expanded: read.expanded },
    { newId: createIdFactory() },
  );
  return { text: r.text, doc: docOf(r.text), read };
}

describe('expanding a role', () => {
  it('copies each task of a role that is not split: handlers as notify links, defaults as inputs, files from the role', async () => {
    const r = await expandRoleSource(
      io,
      { key: 'web', impl: { kind: 'role', ref: 'web', params: { web_port: 9090 } } },
      createIdFactory(),
    );
    expect(r.error).toBeUndefined();
    expect(r.expanded).toMatchObject({ role: 'web', dir: 'roles/web', mode: 'tasks' });
    const nodes = r.source?.subflow?.nodes ?? [];
    expect(nodes.map((n) => n.key)).toEqual([
      'install-the-web-server',
      'write-the-web-config',
      'start-the-web-server',
      'restart-web',
    ]);
    const config = nodes[1] as FlowNode;
    // Found in the role's templates/, written from the repository root (AFD-291).
    expect(config.impl?.params?.src).toBe('{{ afd_repo_root }}/roles/web/templates/web.conf.j2');
    expect(config.notify).toEqual(['restart-web']);
    expect(nodes[3]?.notified).toEqual({});
    expect(handlersNotifiedBy(config, nodes).map((n) => n.key)).toEqual(['restart-web']);
    // Defaults, vars and what the step passed; no hosts input.
    expect(r.source?.inputs).toEqual({
      web_package: { type: 'string', default: 'nginx' },
      web_port: { type: 'integer', default: 9090 },
      web_service: { type: 'string', default: 'nginx' },
    });
    expect(nodes[0]?.inputs?.web_package?.from).toBe('web.web_package');
    // The template reads every role variable.
    expect(Object.keys(config.inputs ?? {}).sort()).toEqual([
      'web_package',
      'web_port',
      'web_service',
    ]);
    expect(nodes.every((n) => !n.origin)).toBe(true);
  });

  it('a role whose main only includes files: a step per file, run as the role', async () => {
    const r = await expandRoleSource(
      io,
      { key: 'split', impl: { kind: 'role', ref: 'split', keywords: { when: 'ready' } } },
      createIdFactory(),
    );
    expect(r.expanded?.mode).toBe('files');
    const nodes = r.source?.subflow?.nodes ?? [];
    expect(nodes.map((n) => n.impl)).toEqual([
      {
        kind: 'role',
        ref: 'split',
        params: { tasks_from: 'prepare' },
        keywords: { when: 'ready' },
      },
      {
        kind: 'role',
        ref: 'split',
        params: { tasks_from: 'apply' },
        keywords: { when: ['ready', 'split_apply | bool'] },
      },
    ]);
  });

  it('refuses a step that runs one task file, and a role that is not in the repository', async () => {
    const one = await expandRoleSource(
      io,
      { key: 's', impl: { kind: 'role', ref: 'split', params: { tasks_from: 'apply' } } },
      createIdFactory(),
    );
    expect(one.error).toMatch(/tasks_from/);
    const gone = await expandRoleSource(
      io,
      { key: 'x', impl: { kind: 'role', ref: 'acme.net.base' } },
      createIdFactory(),
    );
    expect(gone.error).toMatch(/not in the repository/);
  });

  it('the step becomes the subflow in its place: wires kept, valid, and the code runs the copy', async () => {
    const { doc, text } = await expanded(flow('web'), 'web');
    const web = nodeOf(doc, 'web');
    expect(web.id).toBe(ID(2));
    expect(web.type).toBe('subflow');
    expect(web.impl).toEqual({ kind: 'role', ref: 'web' });
    expect(web.expanded_from).toMatchObject({
      role: 'web',
      mode: 'tasks',
      step: { impl: { kind: 'role', ref: 'web' } },
    });
    expect(doc.edges).toHaveLength(3);
    // The copies got fresh IDs.
    expect(web.subflow?.nodes?.every((n) => n.id.length === 26)).toBe(true);
    const errors = validateFlow(doc).findings.filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
    const code = optionA
      .generate(doc, { source: 'site.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(code).toContain('{{ afd_repo_root }}/roles/web/templates/web.conf.j2');
    // A default reaches the step unless the host's own variables set it (AFD-293).
    expect(code).toContain(
      `web_package: "{{ hostvars[inventory_hostname]['web_package'] | default('nginx') }}"`,
    );
    expect(code).toMatch(/write_the_web_config_result \| default\(\{\}\)\) is changed/);
    expect(text).toContain('expanded_from:');
  });

  it('collapses back while it is as it was made, and not after a change', async () => {
    const before = flow('split');
    const { text } = await expanded(before, 'split');
    const id = ID(2);
    const back = planCommand(text, { kind: 'collapseRole', id }, { newId: createIdFactory() });
    const node = nodeOf(docOf(back.text), 'split');
    const { status: _s, ...rest } = node;
    expect(rest).toEqual(nodeOf(docOf(before), 'split'));

    const edited = planCommand(
      text,
      {
        kind: 'updateNode',
        id: nodeOf(docOf(text), 'prepare').id,
        patch: { title: 'Prepare the host' },
      },
      { newId: createIdFactory() },
    ).text;
    expect(() =>
      planCommand(edited, { kind: 'collapseRole', id }, { newId: createIdFactory() }),
    ).toThrow(CommandError);
  });

  it('Update Expanded Role reads the role again from the step it was', async () => {
    const first = await expanded(flow('web', ', params: {web_port: 9090}'), 'web');
    const again = await expanded(first.text, 'web');
    const web = nodeOf(again.doc, 'web');
    expect(web.expanded_from?.step).toEqual({
      impl: { kind: 'role', ref: 'web', params: { web_port: 9090 } },
    });
    expect(web.inputs?.web_port?.default).toBe(9090);
    expect(web.subflow?.nodes).toHaveLength(4);
  });

  it('the canvas menu offers Expand on a role step, and Collapse and Update on the subflow', async () => {
    const menu = (doc: FlowDocument, id: string) => {
      const model = buildModel(doc);
      return canvasMenu(
        model,
        { kind: 'node', id },
        {
          mode: 'design',
          level: ROOT,
          stale: false,
          openPorts: openFailPorts(model),
          hasPlay: () => true,
        },
      ).flatMap((e) => (e.type === 'item' ? [e] : []));
    };
    expect(menu(docOf(flow('web')), ID(2)).map((e) => e.label)).toContain('Expand into Subflow');
    const { doc } = await expanded(flow('web'), 'web');
    const items = menu(doc, ID(2));
    expect(items.find((e) => e.label === 'Collapse to Role Step')?.disabled).toBeUndefined();
    expect(items.map((e) => e.label)).toContain('Update Expanded Role');
    expect(items.map((e) => e.label)).not.toContain('Expand into Subflow');
  });

  it('agents expand and collapse with flow_edit ops', async () => {
    const ctx = { newId: createIdFactory(), source: async () => io };
    const out = await applyOps(flow('web'), [{ op: 'expand_role', node: 'web' }], ctx);
    expect(nodeOf(docOf(out.text), 'web').type).toBe('subflow');
    expect(out.notes.join(' ')).toMatch(/roles\/web\/vars are inputs/);
    const back = await applyOps(out.text, [{ op: 'collapse_role', node: 'web' }], ctx);
    expect(nodeOf(docOf(back.text), 'web').impl).toEqual({ kind: 'role', ref: 'web' });
    await expect(
      applyOps(flow('web'), [{ op: 'expand_role', node: 'web' }], { newId: createIdFactory() }),
    ).rejects.toThrow(/repository files are not available/);
  });

  it('a role that changed since is information; a role folder that is gone a warning', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'afd-role-'));
    cpSync(REPO, repo, { recursive: true });
    const { doc } = await expanded(flow('web'), 'web');
    expect(nodeOf(doc, 'web').expanded_from?.source).toBe(
      roleFingerprint(await roleFiles(fsSource(repo), 'roles/web')),
    );
    expect(roleFindings(doc, repo)).toEqual([]);
    writeFileSync(join(repo, 'roles/web/defaults/main.yml'), 'web_package: apache2\n');
    expect(roleFindings(doc, repo).map((f) => [f.code, f.severity])).toEqual([
      ['role-source', 'info'],
    ]);
    const web = nodeOf(doc, 'web');
    if (web.expanded_from) web.expanded_from.dir = 'roles/gone';
    expect(roleFindings(doc, repo).map((f) => [f.code, f.severity])).toEqual([
      ['role-source', 'warning'],
    ]);
  });
});
