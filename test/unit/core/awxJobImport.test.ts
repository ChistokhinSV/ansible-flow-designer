// AFD-26: AWX job templates, and job template nodes whose playbook is in the repository, imported
// as subflows of the playbook's steps.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { expandable, importWorkflow } from '../../../src/core/awx/import';
import { sanitizedExport } from '../../../src/core/awx/sanitize';
import {
  type AwxExport,
  type AwxReader,
  exportTemplates,
  jobTemplateFromApi,
  jobTemplateFromExport,
  safeUrl,
  workflowFromExport,
} from '../../../src/core/awx/workflow';
import { optionA } from '../../../src/core/engine/optionA';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPrompt } from '../../../src/core/import/prompt';
import { type PlaybookForm, readPlaybook } from '../../../src/core/import/source';
import { fsSource, NETOPS } from './helpers';

const schema = createSchemaValidator();
const PRECHECKS = 'playbooks/prechecks.yml';

/** A fictional export with one job template on the netops pre-checks playbook. */
const EXPORT: AwxExport = {
  job_templates: [
    {
      name: 'Edge pre-checks',
      description: 'Pre-checks before the baseline',
      playbook: PRECHECKS,
      limit: 'edge',
      timeout: 900,
      become_enabled: true,
      survey_enabled: true,
      extra_vars: 'out_dir: /srv/reports\napi_token: $encrypted$\n',
      project: { name: 'Netops', type: 'project' },
      execution_environment: { name: 'Netops EE', type: 'execution_environment' },
      related: {
        credentials: [{ name: 'Edge switches', credential_type: { kind: 'net' } }],
        survey_spec: { spec: [{ variable: 'change_ticket', type: 'text', required: true }] },
      },
    },
    { name: 'Elsewhere', playbook: 'site/other.yml', project: { name: 'Other', type: 'project' } },
  ],
  projects: [
    { name: 'Netops', scm_url: 'https://deploy:s3cret@git.example.net/netops.git' },
    { name: 'Other', scm_url: 'https://git.example.net/other.git' },
  ],
};

async function playbooks(...refs: string[]): Promise<Map<string, PlaybookForm>> {
  const out = new Map<string, PlaybookForm>();
  for (const ref of refs) {
    const read = await readPlaybook(fsSource(NETOPS), ref);
    if (read.playbook) out.set(ref, read.playbook);
  }
  return out;
}

function check(doc: FlowDocument) {
  const text = flowText(doc);
  const parsed = parse(text) as FlowDocument;
  return {
    text,
    findings: validateFlow(parsed, schema(parsed)).findings,
    ok: optionA.generate(parsed, { source: 'x.flow.yaml' }).ok,
  };
}

const node = (doc: FlowDocument, key: string): FlowNode => {
  for (const { node } of buildModel(doc).nodes.values()) if (node.key === key) return node;
  throw new Error(`no node ${key}`);
};

describe('AWX job templates', () => {
  it('lists both kinds in an export file and hides credentials in SCM URLs', () => {
    expect(exportTemplates(EXPORT)).toEqual({
      workflows: [],
      jobs: ['Edge pre-checks', 'Elsewhere'],
    });
    expect(exportTemplates({})).toMatch(/Not an "awx export" file/);
    expect(safeUrl('ssh://git:pw@git.example.net:22/a.git')).toBe('ssh://git.example.net:22/a.git');
  });

  it('imports a job template as its playbook steps, with its inputs and settings', async () => {
    const src = jobTemplateFromExport(EXPORT, 'Edge pre-checks');
    const r = importWorkflow(src, {
      key: 'pre',
      newId: createIdFactory(),
      hasPlaybook: () => true,
      playbooks: await playbooks(PRECHECKS),
      kind: 'awx_job_template',
    });
    const { findings, ok } = check(r.doc);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(ok).toBe(true);
    expect(r.doc.flow.imported_from).toEqual({
      kind: 'awx_job_template',
      template: 'Edge pre-checks',
      path: PRECHECKS,
    });
    // The limit is where the flow runs; survey and extra vars are inputs (the encrypted by name).
    expect(r.doc.flow.inputs).toMatchObject({
      devices: { type: 'host_list', default: ['edge'] },
      change_ticket: { type: 'string', required: true },
      out_dir: { type: 'string', default: '/srv/reports' },
      api_token: { type: 'string' },
    });
    expect(r.doc.flow.inputs?.api_token).not.toHaveProperty('default');
    const sub = node(r.doc, 'edge-pre-checks');
    expect(sub).toMatchObject({
      type: 'subflow',
      status: 'implemented',
      settings: { credential: 'Edge switches', execution_environment: 'Netops EE' },
    });
    expect(sub.settings).not.toHaveProperty('inventory_target');
    expect(sub.subflow?.nodes?.map((n) => n.key)).toEqual([
      'create-the-report-folder',
      'read-the-software-version',
      'check-the-version-is-supported',
      'record-the-pre-check',
    ]);
    expect(node(r.doc, 'read-the-software-version').settings).toEqual({
      become: true,
      timeout: '15m',
    });
    expect(r.counts).toEqual({ steps: 4, implemented: 4, drafts: 0 });
  });

  it('keeps a playbook from another repository as a draft step, naming where it lives', () => {
    const r = importWorkflow(jobTemplateFromExport(EXPORT, 'Elsewhere'), {
      key: 'x',
      newId: createIdFactory(),
      hasPlaybook: () => false,
      kind: 'awx_job_template',
    });
    expect(node(r.doc, 'elsewhere')).toMatchObject({
      status: 'draft',
      impl: { kind: 'playbook', ref: 'site/other.yml' },
    });
    expect(r.notes.join('\n')).toContain(
      'site/other.yml (project Other, https://git.example.net/other.git) is not in this repository',
    );
  });

  it('reads a job template, its survey and its project through the API', async () => {
    const answers: Record<string, unknown> = {
      '/api/v2/job_templates/7/': {
        id: 7,
        name: 'Edge pre-checks',
        playbook: PRECHECKS,
        project: 3,
        survey_enabled: true,
        extra_vars: '{"out_dir": "/srv/reports"}',
        summary_fields: {
          project: { name: 'Netops' },
          credentials: [{ name: 'Edge switches', kind: 'net' }],
        },
      },
      '/api/v2/job_templates/7/survey_spec/': {
        spec: [{ variable: 'change_ticket', type: 'text' }],
      },
      '/api/v2/projects/3/': { scm_url: 'https://deploy:s3cret@git.example.net/netops.git' },
    };
    const reader: AwxReader = {
      get: async <T>(path: string) => answers[path] as T,
      all: async () => [],
    };
    const src = await jobTemplateFromApi(reader, 7);
    expect(src).toMatchObject({
      name: 'Edge pre-checks',
      id: 7,
      extraVars: { out_dir: '/srv/reports' },
    });
    expect(src.nodes[0]?.job).toMatchObject({
      playbook: PRECHECKS,
      project: 'Netops',
      scmUrl: 'https://git.example.net/netops.git',
    });
  });
});

describe('workflow job nodes with a playbook in the repository', () => {
  const data = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/awx/import/export.json'), 'utf8'),
  ) as AwxExport;

  it('stay playbook steps for playbooks the designer generated', async () => {
    const generated = (await playbooks(PRECHECKS)).get(PRECHECKS) as PlaybookForm;
    expect(expandable('flows/awx-e2e/generated/awx-e2e.yml', generated)).toBe(false);
    expect(expandable(PRECHECKS, generated)).toBe(true);
  });

  it('become subflows of the playbook steps, the node extra vars on each step', async () => {
    const src = workflowFromExport(data, 'AFD fixture · edge upgrade');
    // Point one job template at the netops pre-checks, as if the project were this repository.
    const job = src.nodes.find((n) => n.kind === 'job' && n.job) as (typeof src.nodes)[number];
    job.job = { ...job.job, credentials: job.job?.credentials ?? [], playbook: PRECHECKS };
    job.extraData = { out_dir: '/srv/edge', vault_password: 'x' };
    const r = importWorkflow(src, {
      key: 'edge',
      newId: createIdFactory(),
      hasPlaybook: () => true,
      playbooks: await playbooks(PRECHECKS),
    });
    const { findings, ok, text } = check(r.doc);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(ok).toBe(true);
    expect(text).not.toContain('vault_password: x');
    const sub = node(r.doc, job.identifier);
    expect(sub.type).toBe('subflow');
    const step = sub.subflow?.nodes?.find((n) => n.key === 'record-the-pre-check');
    expect(step?.impl?.keywords?.vars).toEqual({ out_dir: '/srv/edge' });
    expect(r.doc.flow.inputs).toHaveProperty('out_dir');
  });
});

describe('AFD-27: the sanitized export an AI assistant reads', () => {
  const data = JSON.parse(
    readFileSync(join(__dirname, '../../fixtures/awx/import/export.json'), 'utf8'),
  ) as AwxExport;
  /** Nodes and wires by key: two imports differ only in their ids. */
  const shape = (doc: FlowDocument): unknown =>
    JSON.parse(
      JSON.stringify(doc, (k, v) => (k === 'id' || k === 'node' || k === 'in' ? undefined : v)),
    );

  it('imports to the same flow as the original export, with no secret values', () => {
    const name = 'AFD fixture · edge upgrade';
    const src = workflowFromExport(data, name);
    // A secret the AWX export kept in clear would still not leave the extension.
    const first = src.nodes.find((n) => n.kind === 'job') as (typeof src.nodes)[number];
    first.extraData = { ...first.extraData, api_token: 'tok-123-example' };
    const clean = sanitizedExport(src, 'workflow');
    const text = JSON.stringify(clean);
    expect(text).not.toContain('tok-123-example');
    expect(text).toContain('"api_token":"$encrypted$"');
    const again = workflowFromExport(clean, name);
    const opts = { key: 'edge', newId: createIdFactory(), hasPlaybook: () => true };
    expect(shape(importWorkflow(again, opts).doc)).toEqual(shape(importWorkflow(src, opts).doc));
  });

  it('a job template keeps its playbook, limit, survey (without secret defaults) and project', () => {
    const src = jobTemplateFromExport(EXPORT, 'Edge pre-checks');
    src.survey = [
      { variable: 'change_ticket', type: 'text', default: 'CHG0001' },
      { variable: 'enable_pw', type: 'password', default: 'secret-default' },
    ];
    const clean = sanitizedExport(src, 'job');
    expect(JSON.stringify(clean)).not.toContain('secret-default');
    expect(clean.projects).toEqual([
      { name: 'Netops', scm_url: 'https://git.example.net/netops.git' },
    ]);
    const back = jobTemplateFromExport(clean, 'Edge pre-checks');
    expect(back).toMatchObject({ limit: 'edge', nodes: [{ job: { playbook: PRECHECKS } }] });
    expect(back.survey).toEqual([
      { variable: 'change_ticket', type: 'text', default: 'CHG0001' },
      { variable: 'enable_pw', type: 'password' },
    ]);
  });

  it('the prompt names the source, the flow to write and the tools', () => {
    const text = importPrompt({
      sources: ['flows/edge/source/awx-export.json'],
      targets: ['flows/edge/edge.flow.yaml'],
      template: { kind: 'workflow', name: 'Edge upgrade' },
    });
    expect(text).toContain('the AWX workflow template "Edge upgrade"');
    expect(text).toContain('- flows/edge/source/awx-export.json → flows/edge/edge.flow.yaml');
    for (const tool of [
      'source_outline',
      'flow_new',
      'flow_edit',
      'set_io',
      'flow_validate',
      'flow_import',
    ])
      expect(text).toContain(tool);
  });
});
