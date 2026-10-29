// AWX workflow job templates as import sources (M9, ADR-0015). The AWX API (v2) and an
// `awx export` file both become one normalized shape, so a single mapper builds the flow. Pure: the
// API is read through a two-method reader that AwxClient satisfies.
import { parse } from 'yaml';

export type WorkflowNodeKind =
  | 'job'
  | 'workflow'
  | 'approval'
  | 'project_update'
  | 'inventory_update'
  | 'system_job'
  | 'missing';

export interface JobTemplateInfo {
  playbook?: string;
  project?: string;
  description?: string;
  limit?: string;
  /** Seconds; 0 is no timeout. */
  timeout?: number;
  become?: boolean;
  executionEnvironment?: string;
  credentials: { name: string; kind?: string }[];
}

export interface SurveyQuestion {
  variable: string;
  type: string;
  required?: boolean;
  default?: unknown;
}

export interface WorkflowNodeSource {
  /** Unique in its workflow; AWX assigns a UUID when the author gave none. */
  identifier: string;
  kind: WorkflowNodeKind;
  /** The template's name ('' when the node has none). */
  name: string;
  description?: string;
  /** Job template details, when the source has them. */
  job?: JobTemplateInfo;
  /** A nested workflow, resolved. */
  workflow?: WorkflowSource;
  /** Why a nested workflow is not resolved (a cycle, too deep, not in the file). */
  unresolved?: string;
  /** Approval timeout in seconds (0: none). */
  timeout?: number;
  /** AWX convergence "all": runs only when every parent took its edge. */
  converge: boolean;
  extraData?: Record<string, unknown>;
  limit?: string;
  jobTags?: string;
  credentials?: string[];
  /** Child identifiers per edge type. */
  success: string[];
  failure: string[];
  always: string[];
}

export interface WorkflowSource {
  name: string;
  id?: number;
  description?: string;
  extraVars?: Record<string, unknown>;
  limit?: string;
  survey?: SurveyQuestion[];
  nodes: WorkflowNodeSource[];
}

/** Nested workflows deeper than this are imported as subflows without inner steps. */
export const MAX_DEPTH = 4;

/** AWX keeps extra vars as YAML or JSON text; anything but a map is ignored. */
export function varsOf(value: unknown): Record<string, unknown> | undefined {
  let v = value;
  if (typeof v === 'string') {
    try {
      v = parse(v);
    } catch {
      return undefined;
    }
  }
  return v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length > 0
    ? (v as Record<string, unknown>)
    : undefined;
}

const text = (s: unknown): string | undefined =>
  typeof s === 'string' && s.trim() ? s : undefined;

// ---- AWX API -----------------------------------------------------------------------------------

export interface AwxReader {
  get<T>(path: string): Promise<T>;
  all<T>(path: string): Promise<T[]>;
}

interface ApiWorkflow {
  id: number;
  name: string;
  description?: string;
  extra_vars?: unknown;
  limit?: string | null;
  survey_enabled?: boolean;
}

interface ApiNode {
  id: number;
  identifier?: string;
  summary_fields?: {
    unified_job_template?: {
      id: number;
      name: string;
      description?: string;
      unified_job_type: string;
      timeout?: number;
    };
  };
  success_nodes: number[];
  failure_nodes: number[];
  always_nodes: number[];
  all_parents_must_converge?: boolean;
  extra_data?: unknown;
  limit?: string | null;
  job_tags?: string | null;
}

interface ApiJobTemplate {
  playbook?: string;
  description?: string;
  limit?: string;
  timeout?: number;
  become_enabled?: boolean;
  ask_credential_on_launch?: boolean;
  summary_fields?: {
    project?: { name: string };
    execution_environment?: { name: string };
    credentials?: { name: string; kind?: string }[];
  };
}

const API_KIND: Record<string, WorkflowNodeKind> = {
  job: 'job',
  workflow_job: 'workflow',
  workflow_approval: 'approval',
  project_update: 'project_update',
  inventory_update: 'inventory_update',
  system_job: 'system_job',
};

/** A workflow job template and every workflow it nests, read through the AWX API. */
export async function workflowFromApi(
  reader: AwxReader,
  id: number,
  seen: number[] = [],
  jobTemplates = new Map<number, Promise<ApiJobTemplate>>(),
): Promise<WorkflowSource> {
  const wf = await reader.get<ApiWorkflow>(`/api/v2/workflow_job_templates/${id}/`);
  const survey = wf.survey_enabled
    ? (
        await reader.get<{ spec?: SurveyQuestion[] }>(
          `/api/v2/workflow_job_templates/${id}/survey_spec/`,
        )
      ).spec
    : undefined;
  const raw = await reader.all<ApiNode>(`/api/v2/workflow_job_templates/${id}/workflow_nodes/`);
  const ident = new Map(raw.map((n) => [n.id, n.identifier || String(n.id)]));
  const ids = (list: number[]) => list.map((i) => ident.get(i)).filter((i): i is string => !!i);
  const path = [...seen, id];
  const nodes: WorkflowNodeSource[] = [];
  for (const n of raw) {
    const ujt = n.summary_fields?.unified_job_template;
    const kind = ujt ? (API_KIND[ujt.unified_job_type] ?? 'missing') : 'missing';
    const node: WorkflowNodeSource = {
      identifier: ident.get(n.id) as string,
      kind,
      name: ujt?.name ?? '',
      // Syncs and system jobs describe their project or source, not this step.
      description: ['job', 'workflow', 'approval'].includes(kind)
        ? text(ujt?.description)
        : undefined,
      converge: !!n.all_parents_must_converge,
      extraData: varsOf(n.extra_data),
      limit: text(n.limit),
      jobTags: text(n.job_tags),
      success: ids(n.success_nodes),
      failure: ids(n.failure_nodes),
      always: ids(n.always_nodes),
    };
    if (kind === 'approval') node.timeout = ujt?.timeout ?? 0;
    if (kind === 'job' && ujt) {
      let jt = jobTemplates.get(ujt.id);
      if (!jt) {
        jt = reader.get<ApiJobTemplate>(`/api/v2/job_templates/${ujt.id}/`);
        jobTemplates.set(ujt.id, jt);
      }
      const t = await jt;
      node.job = {
        playbook: text(t.playbook),
        project: t.summary_fields?.project?.name,
        description: text(t.description),
        limit: text(t.limit),
        timeout: t.timeout,
        become: t.become_enabled,
        executionEnvironment: t.summary_fields?.execution_environment?.name,
        credentials: (t.summary_fields?.credentials ?? []).map((c) => ({
          name: c.name,
          kind: c.kind,
        })),
      };
      // Only a template that prompts for credentials lets a node carry its own.
      if (t.ask_credential_on_launch)
        node.credentials = (
          await reader.all<{ name: string }>(
            `/api/v2/workflow_job_template_nodes/${n.id}/credentials/`,
          )
        ).map((c) => c.name);
    }
    if (kind === 'workflow' && ujt) {
      if (path.includes(ujt.id)) node.unresolved = 'it nests a workflow that contains it';
      else if (path.length >= MAX_DEPTH) node.unresolved = `nesting is deeper than ${MAX_DEPTH}`;
      else node.workflow = await workflowFromApi(reader, ujt.id, path, jobTemplates);
    }
    nodes.push(node);
  }
  return {
    name: wf.name,
    id: wf.id,
    description: text(wf.description),
    extraVars: varsOf(wf.extra_vars),
    limit: text(wf.limit),
    survey,
    nodes,
  };
}

// ---- awx export file ---------------------------------------------------------------------------

interface ExportRef {
  name: string;
  type?: string;
}

interface ExportNode {
  identifier: string;
  unified_job_template?: ExportRef | null;
  all_parents_must_converge?: boolean;
  extra_data?: unknown;
  limit?: string | null;
  job_tags?: string | null;
  related?: {
    success_nodes?: { identifier: string }[];
    failure_nodes?: { identifier: string }[];
    always_nodes?: { identifier: string }[];
    credentials?: { name: string }[];
    create_approval_template?: { name: string; description?: string; timeout?: number };
  };
}

interface ExportWorkflow {
  name: string;
  description?: string;
  extra_vars?: unknown;
  limit?: string | null;
  survey_enabled?: boolean;
  related?: {
    workflow_nodes?: ExportNode[];
    survey_spec?: { spec?: SurveyQuestion[] };
  };
}

interface ExportJobTemplate {
  name: string;
  description?: string;
  playbook?: string;
  limit?: string;
  timeout?: number;
  become_enabled?: boolean;
  project?: ExportRef | null;
  execution_environment?: ExportRef | null;
  related?: { credentials?: { name: string; credential_type?: { kind?: string } }[] };
}

/** What `awx export --workflow_job_templates --job_templates` writes (awxkit). */
export interface AwxExport {
  workflow_job_templates?: ExportWorkflow[];
  job_templates?: ExportJobTemplate[];
}

const EXPORT_KIND: Record<string, WorkflowNodeKind> = {
  job_template: 'job',
  workflow_job_template: 'workflow',
  project: 'project_update',
  inventory_source: 'inventory_update',
  system_job_template: 'system_job',
};

/** The workflow names in an export file, or why the data is not one. */
export function exportWorkflows(data: unknown): string[] | string {
  const list = (data as AwxExport | undefined)?.workflow_job_templates;
  if (!data || typeof data !== 'object' || !Array.isArray(list))
    return 'Not an "awx export" file: it has no workflow_job_templates';
  const names = list.map((w) => w?.name).filter((n): n is string => typeof n === 'string');
  return names.length ? names : 'The export file has no workflow job templates';
}

/** One workflow of an export file, with the workflows it nests that the file also has. */
export function workflowFromExport(
  data: AwxExport,
  name: string,
  seen: string[] = [],
): WorkflowSource {
  const wf = data.workflow_job_templates?.find((w) => w.name === name);
  if (!wf) throw new Error(`The export file has no workflow "${name}"`);
  const jts = new Map((data.job_templates ?? []).map((t) => [t.name, t]));
  const path = [...seen, name];
  const nodes = (wf.related?.workflow_nodes ?? []).map((n): WorkflowNodeSource => {
    const ujt = n.unified_job_template;
    const approval = n.related?.create_approval_template;
    const kind: WorkflowNodeKind = ujt
      ? (EXPORT_KIND[ujt.type ?? ''] ?? 'missing')
      : approval
        ? 'approval'
        : 'missing';
    const ids = (list?: { identifier: string }[]) => (list ?? []).map((c) => c.identifier);
    const node: WorkflowNodeSource = {
      identifier: n.identifier,
      kind,
      name: approval?.name ?? ujt?.name ?? '',
      description: text(approval?.description),
      converge: !!n.all_parents_must_converge,
      extraData: varsOf(n.extra_data),
      limit: text(n.limit),
      jobTags: text(n.job_tags),
      success: ids(n.related?.success_nodes),
      failure: ids(n.related?.failure_nodes),
      always: ids(n.related?.always_nodes),
    };
    const creds = (n.related?.credentials ?? []).map((c) => c.name);
    if (creds.length) node.credentials = creds;
    if (kind === 'approval') node.timeout = approval?.timeout ?? 0;
    const t = kind === 'job' && ujt ? jts.get(ujt.name) : undefined;
    if (t) {
      node.description = text(t.description);
      node.job = {
        playbook: text(t.playbook),
        project: t.project?.name,
        description: text(t.description),
        limit: text(t.limit),
        timeout: t.timeout,
        become: t.become_enabled,
        executionEnvironment: t.execution_environment?.name,
        credentials: (t.related?.credentials ?? []).map((c) => ({
          name: c.name,
          kind: c.credential_type?.kind,
        })),
      };
    }
    if (kind === 'workflow' && ujt) {
      if (path.includes(ujt.name)) node.unresolved = 'it nests a workflow that contains it';
      else if (path.length >= MAX_DEPTH) node.unresolved = `nesting is deeper than ${MAX_DEPTH}`;
      else if (!data.workflow_job_templates?.some((w) => w.name === ujt.name))
        node.unresolved = 'the export file does not have it';
      else {
        node.workflow = workflowFromExport(data, ujt.name, path);
        node.description = node.workflow.description;
      }
    }
    return node;
  });
  return {
    name: wf.name,
    description: text(wf.description),
    extraVars: varsOf(wf.extra_vars),
    limit: text(wf.limit),
    survey: wf.survey_enabled ? wf.related?.survey_spec?.spec : undefined,
    nodes,
  };
}

/** Every playbook the source binds, nested workflows included (checked against the repository). */
export function playbooksOf(src: WorkflowSource): string[] {
  const out = new Set<string>();
  const walk = (w: WorkflowSource) => {
    for (const n of w.nodes) {
      if (n.job?.playbook) out.add(n.job.playbook);
      if (n.workflow) walk(n.workflow);
    }
  };
  walk(src);
  return [...out];
}
