// M9 (AFD-15): AWX workflow import. The fixture workflows were recorded from a lab AWX: api.json
// holds the API answers the import reads, export.json the same workflows from `awx export`. Both
// sources must give the same flow.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { duration, importWorkflow } from '../../../src/core/awx/import';
import {
  type AwxExport,
  type AwxReader,
  exportWorkflows,
  playbooksOf,
  type WorkflowSource,
  workflowFromApi,
  workflowFromExport,
} from '../../../src/core/awx/workflow';
import { optionA } from '../../../src/core/engine/optionA';
import { parseFlow } from '../../../src/core/flow/document';
import { nodeSize } from '../../../src/core/flow/geometry';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument, FlowNode, Position } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { layoutAll } from '../../../src/node/autoLayout';

const DIR = join(__dirname, '../../fixtures/awx/import');
const api = JSON.parse(readFileSync(join(DIR, 'api.json'), 'utf8')) as Record<string, unknown>;
const exported = JSON.parse(readFileSync(join(DIR, 'export.json'), 'utf8')) as AwxExport;
const OUTER = 'AFD fixture · edge upgrade';
const PLAYBOOK = 'flows/awx-e2e/generated/awx-e2e.yml';
const schema = createSchemaValidator();

function reader(answers: Record<string, unknown>): AwxReader {
  const answer = (path: string) => {
    if (!(path in answers)) throw new Error(`unexpected request ${path}`);
    return structuredClone(answers[path]);
  };
  return {
    get: async <T>(path: string) => answer(path) as T,
    all: async <T>(path: string) => answer(path) as T[],
  };
}

const run = (src: WorkflowSource, hasPlaybook: (ref: string) => boolean = (r) => r === PLAYBOOK) =>
  importWorkflow(src, { key: 'edge-upgrade', newId: createIdFactory(), hasPlaybook });

/** Edges as `from.port -> to` by key, per level (ids differ between imports). */
function shape(doc: FlowDocument): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const level of buildModel(doc).levels.values()) {
    const key = new Map(level.nodes.map((n) => [n.id, n.key]));
    const parent = level.parent ? buildModel(doc).nodes.get(level.parent)?.node : undefined;
    out[level.id === ROOT ? 'root' : (parent?.key as string)] = {
      nodes: Object.fromEntries(
        level.nodes.map((n) => {
          const { id, subflow, ...rest } = n;
          return [n.key, rest];
        }),
      ),
      edges: level.edges
        .map((e) => `${key.get(e.from.node)}.${e.from.port} -> ${key.get(e.to.node)}`)
        .sort(),
      boundary: parent?.subflow?.boundary
        ? JSON.stringify(parent.subflow.boundary, (k, v) =>
            (k === 'in' || k === 'node') && typeof v === 'string' ? key.get(v) : v,
          )
        : undefined,
    };
  }
  return out;
}

describe('AWX workflow sources', () => {
  it('the export file lists its workflows; other JSON is refused', () => {
    expect(exportWorkflows(exported)).toEqual([OUTER, 'AFD fixture · upgrade steps']);
    expect(exportWorkflows({ job_templates: [] })).toMatch(/Not an "awx export" file/);
  });

  it('the API and the export file give the same normalized nodes', async () => {
    const fromApi = await workflowFromApi(reader(api), 21);
    const fromFile = workflowFromExport(exported, OUTER);
    const strip = (w: WorkflowSource): unknown => ({
      ...w,
      id: undefined,
      nodes: [...w.nodes]
        .sort((a, b) => a.identifier.localeCompare(b.identifier))
        .map((n) => ({ ...n, workflow: n.workflow && strip(n.workflow) })),
    });
    expect(strip(fromApi)).toEqual(strip(fromFile));
    expect(fromApi.id).toBe(21);
    expect(playbooksOf(fromApi).sort()).toEqual([PLAYBOOK, 'hello_world.yml']);
  });
});

describe('AWX workflow → flow', () => {
  const src = workflowFromExport(exported, OUTER);
  const result = run(src);
  const { doc } = result;
  const node = (key: string, nodes: FlowNode[] = doc.nodes) =>
    nodes.find((n) => n.key === key) as FlowNode;
  const upgrade = node('upgrade');
  const inner = upgrade.subflow?.nodes ?? [];

  it('is a valid flow: schema, no errors, and the text round-trips', () => {
    expect(schema(doc)).toEqual([]);
    const errors = validateFlow(doc).findings.filter((f) => f.severity === 'error');
    expect(errors).toEqual([]);
    const text = flowText(doc);
    expect(parseFlow(text).doc).toEqual(doc);
    expect(doc.flow).toMatchObject({
      key: 'edge-upgrade',
      name: OUTER,
      version: 1,
      goal: 'Upgrade the edge switches in one maintenance window',
      imported_from: { kind: 'awx_workflow', template: OUTER },
    });
  });

  it('maps every AWX node once and every edge to its ports', () => {
    const s = shape(doc);
    expect(s.root).toMatchObject({
      edges: [
        'after-upgrade.branch_1 -> verify',
        'after-upgrade.branch_2 -> report',
        'afd-fixture-notify-on-call.ok_hosts -> done',
        'approve.approved -> upgrade',
        'approve.rejected -> afd-fixture-notify-on-call',
        'approve.timeout -> afd-fixture-notify-on-call',
        'precheck.failed_hosts -> afd-fixture-notify-on-call',
        'precheck.ok_hosts -> approve',
        'report.ok_hosts -> done',
        // AWX always is a failure handler: both outcomes go on.
        'rollback.failed_hosts -> afd-fixture-notify-on-call',
        'rollback.ok_hosts -> afd-fixture-notify-on-call',
        'start.ok_hosts -> precheck',
        'upgrade.failed_hosts -> rollback',
        'upgrade.ok_hosts -> after-upgrade',
        'verify.ok_hosts -> done',
      ].sort(),
    });
    expect(s.upgrade).toMatchObject({
      edges: [
        'backup.ok_hosts -> join-install',
        'install.ok_hosts -> reload',
        'join-install.ok_hosts -> install',
        'start-in-parallel.branch_1 -> sync',
        'start-in-parallel.branch_2 -> backup',
        'sync.ok_hosts -> join-install',
      ].sort(),
      boundary: JSON.stringify({
        in: 'start-in-parallel',
        outputs: { ok_hosts: [{ node: 'reload', port: 'ok_hosts' }] },
      }),
    });
    const types = Object.fromEntries(doc.nodes.map((n) => [n.key, n.type]));
    expect(types).toEqual({
      start: 'start',
      precheck: 'task',
      approve: 'approval',
      upgrade: 'subflow',
      verify: 'task',
      report: 'task',
      rollback: 'task',
      'afd-fixture-notify-on-call': 'task',
      'after-upgrade': 'parallel',
      done: 'end',
    });
    expect(node('after-upgrade').branches).toBe(2);
    expect(node('join-install', inner)).toMatchObject({ type: 'join', join_mode: 'all' });
    expect(node('start-in-parallel', inner)).toMatchObject({
      type: 'parallel',
      branches: 2,
    });
    expect(result.counts).toEqual({ steps: 10, implemented: 7, drafts: 3 });
  });

  it('binds job templates; status by the playbook in this repository', () => {
    expect(node('precheck')).toMatchObject({
      title: 'AFD fixture · precheck',
      intent: 'Check reachability and free flash before the upgrade',
      status: 'implemented',
      impl: { kind: 'playbook', ref: PLAYBOOK, params: { min_flash_mb: 512 } },
      settings: {
        inventory_target: 'edge',
        tags: ['precheck'],
      },
    });
    expect(node('install', inner)).toMatchObject({ status: 'implemented' });
    expect(node('install', inner).settings?.become).toBe(true);
    expect(node('reload', inner).settings?.timeout).toBe('15m');
    // A playbook this repository does not have: bound, so implemented in format 2 (AFD-50); the
    // import counts it to check (counts above) and says why in its notes.
    expect(node('report')).toMatchObject({
      status: 'implemented',
      impl: { kind: 'playbook', ref: 'hello_world.yml' },
    });
    expect(node('sync', inner)).toEqual({
      id: node('sync', inner).id,
      key: 'sync',
      type: 'task',
      title: 'AFD lab',
      intent: 'AWX project sync: AFD lab',
      status: 'draft',
    });
    expect(node('approve')).toMatchObject({
      title: 'Approve the upgrade window',
      intent: 'Network on-call approves',
      ports: ['timeout'],
      settings: { timeout: '30m' },
    });
    expect(result.notes).toContain(
      '"report": hello_world.yml (project Demo Project) is not in this repository: draft; its play cannot load until the playbook is added or the binding changes. With the project checked out here, import again to get its steps.',
    );
  });

  it('the banner shows exactly the failures AWX does not handle; inner ones bubble', () => {
    const open = openFailPorts(buildModel(doc)).map(
      (p) => `${buildModel(doc).nodes.get(p.node)?.node.key}.${p.port}`,
    );
    expect(open.sort()).toEqual([
      'afd-fixture-notify-on-call.failed_hosts',
      'report.failed_hosts',
      'verify.failed_hosts',
    ]);
  });

  it('flow inputs: the survey, extra vars and targets; secrets by name only', () => {
    expect(doc.flow.inputs).toEqual({
      devices: { type: 'host_list', required: true, targets: true, default: ['edge'] },
      change_ticket: { type: 'string', required: true, default: 'CHG0001234' },
      reboot_wait: { type: 'integer', default: 300 },
      image: { type: 'string', required: true, default: '17.9.4' },
      lab_enable_password: { type: 'string' },
      site: { type: 'string', default: 'edge-lab' },
    });
    const text = flowText(doc);
    expect(text).not.toContain('$encrypted$');
    expect(text).not.toContain('fictional-lab-only');
    expect(result.notes).toContain(
      'Imported by name only (encrypted or secret-looking): lab_enable_password.',
    );
  });

  it('generates code with the Option A engine (no errors)', () => {
    const out = optionA.generate(doc, { source: 'edge-upgrade.flow.yaml' });
    expect(out.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(out.ok).toBe(true);
    expect(out.files.map((f) => f.name).sort()).toEqual([
      'edge-upgrade.seg_approve-approved.yml',
      'edge-upgrade.seg_approve-rejected.yml',
      'edge-upgrade.seg_finish.yml',
      'edge-upgrade.seg_start.yml',
      'edge-upgrade.upgrade.yml',
      'edge-upgrade.yml',
    ]);
  });

  it('ELK lays out every level top-down without overlaps', async () => {
    const laid = structuredClone(doc);
    await layoutAll(laid);
    const layout = laid.layout ?? {};
    for (const level of buildModel(laid).levels.values()) {
      for (const n of level.nodes) expect(layout[n.id], n.key).toBeDefined();
      for (const e of level.edges)
        expect(layout[e.to.node]?.y, `${e.from.node} -> ${e.to.node}`).toBeGreaterThan(
          layout[e.from.node]?.y as number,
        );
      const boxes = level.nodes.map((n) => ({
        ...(layout[n.id] as Position),
        ...nodeSize(n.type),
        n,
      }));
      for (const [i, a] of boxes.entries())
        for (const b of boxes.slice(i + 1)) {
          const apart =
            a.x + a.width <= b.x ||
            b.x + b.width <= a.x ||
            a.y + a.height <= b.y ||
            b.y + b.height <= a.y;
          expect(apart, `${a.n.key} overlaps ${b.n.key}`).toBe(true);
        }
    }
    expect(schema(laid)).toEqual([]);
  });

  it('the whole file matches the golden import (fixed ids)', async () => {
    let i = 0;
    const seq = () => `01JDAWX${String(++i).padStart(19, '0')}`;
    const fixed = importWorkflow(src, {
      key: 'edge-upgrade',
      newId: seq,
      hasPlaybook: (r) => r === PLAYBOOK,
    }).doc;
    await layoutAll(fixed);
    const golden = join(DIR, 'edge-upgrade.flow.yaml');
    if (process.env.AFD_UPDATE_GOLDEN) writeFileSync(golden, flowText(fixed));
    expect(flowText(fixed)).toBe(readFileSync(golden, 'utf8'));
  });
});

describe('AWX import edge cases', () => {
  const job = (identifier: string, more: Partial<WorkflowSource['nodes'][number]> = {}) => ({
    identifier,
    kind: 'job' as const,
    name: `Job ${identifier}`,
    converge: false,
    success: [],
    failure: [],
    always: [],
    job: { playbook: 'site.yml', credentials: [] },
    ...more,
  });

  it('several roots fan out from start; UUID identifiers key by name; empty ports end', () => {
    const { doc } = run(
      {
        name: 'Two roots',
        nodes: [job('2c7a8f40-0a51-4c5e-9b0f-6a1e0b9d4b11', { name: 'Backup routers' }), job('b')],
      },
      () => true,
    );
    expect(shape(doc).root).toMatchObject({
      edges: [
        'after-start.branch_1 -> backup-routers',
        'after-start.branch_2 -> b',
        'b.ok_hosts -> done',
        'backup-routers.ok_hosts -> done',
        'start.ok_hosts -> after-start',
      ].sort(),
    });
  });

  it('a workflow that nests itself stops with a note; missing templates are drafts', async () => {
    const answers = {
      '/api/v2/workflow_job_templates/5/': { id: 5, name: 'Loop', survey_enabled: false },
      '/api/v2/workflow_job_templates/5/workflow_nodes/': [
        {
          id: 1,
          identifier: 'again',
          summary_fields: {
            unified_job_template: { id: 5, name: 'Loop', unified_job_type: 'workflow_job' },
          },
          success_nodes: [2],
          failure_nodes: [],
          always_nodes: [],
        },
        {
          id: 2,
          identifier: 'gone',
          summary_fields: {},
          success_nodes: [],
          failure_nodes: [],
          always_nodes: [],
        },
      ],
    };
    const result = run(await workflowFromApi(reader(answers), 5));
    expect(result.notes).toContain(
      '"again" nests "Loop", but it nests a workflow that contains it: no inner steps.',
    );
    expect(result.notes).toContain('"gone" has no template in AWX: a draft task.');
    expect(result.doc.nodes.find((n) => n.key === 'again')?.subflow).toBeUndefined();
    expect(result.doc.nodes.find((n) => n.key === 'missing-template')).toBeUndefined();
    expect(result.doc.nodes.find((n) => n.key === 'gone')).toMatchObject({
      type: 'task',
      title: 'Missing template',
      status: 'draft',
    });
  });

  it('secret-looking extra vars and node data keep their names only', () => {
    const result = run({
      name: 'Secrets',
      extraVars: { api_token: 'not-for-the-file', region: 'eu' },
      survey: [
        { variable: 'zones', type: 'multiselect', default: 'a\nb' },
        { variable: 'ssh_private_key', type: 'textarea', default: 'not-for-the-file' },
      ],
      nodes: [job('a', { extraData: { db_password: 'not-for-the-file', vlan: 120 } })],
    });
    const text = flowText(result.doc);
    expect(text).not.toContain('not-for-the-file');
    expect(result.doc.flow.inputs).toMatchObject({
      zones: { type: 'list', default: ['a', 'b'] },
      ssh_private_key: { type: 'string' },
      api_token: { type: 'string' },
      region: { type: 'string', default: 'eu' },
    });
    expect(result.doc.nodes.find((n) => n.key === 'a')?.impl?.params).toEqual({ vlan: 120 });
    expect(result.notes).toContain(
      'Imported by name only (encrypted or secret-looking): api_token, db_password, ssh_private_key.',
    );
  });

  it('durations read like the settings format', () => {
    expect([duration(1800), duration(5400), duration(45), duration(3661)]).toEqual([
      '30m',
      '1h30m',
      '45s',
      '1h1m1s',
    ]);
  });
});
