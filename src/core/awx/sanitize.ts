// An AWX template as an `awx export` file an AI assistant may read (AFD-27): built from the
// normalized source only (never from raw API answers), with every secret value replaced by AWX's
// own `$encrypted$` marker, so the importers keep those variables by name only. The AWX token never
// leaves the extension.
import { ENCRYPTED, isSecret } from '../import/secrets';
import type { AwxExport, JobTemplateInfo, SurveyQuestion, WorkflowSource } from './workflow';

type ExportWorkflow = NonNullable<AwxExport['workflow_job_templates']>[number];
type ExportJob = NonNullable<AwxExport['job_templates']>[number];

/** A copy whose secret values are `$encrypted$`; undefined stays undefined. */
function scrub(vars: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!vars) return undefined;
  return Object.fromEntries(
    Object.entries(vars).map(([k, v]) => [k, isSecret(k, v) ? ENCRYPTED : v]),
  );
}

/** Survey questions without secret defaults (password answers, secret-looking names). */
function survey(spec: SurveyQuestion[] | undefined): { spec: SurveyQuestion[] } | undefined {
  if (!spec?.length) return undefined;
  return {
    spec: spec.map((q) => {
      const { default: value, ...rest } = q;
      const secret = q.type === 'password' || isSecret(q.variable, value);
      return secret || value === undefined ? rest : { ...rest, default: value };
    }),
  };
}

const KIND: Record<string, string> = {
  job: 'job_template',
  workflow: 'workflow_job_template',
  project_update: 'project',
  inventory_update: 'inventory_source',
  system_job: 'system_job_template',
};

/** The export of one workflow (with what it nests) or one job template. */
export function sanitizedExport(src: WorkflowSource, kind: 'workflow' | 'job'): AwxExport {
  const workflows: ExportWorkflow[] = [];
  const jobs = new Map<string, ExportJob>();
  const projects = new Map<string, { name: string; scm_url?: string }>();

  const job = (
    name: string,
    info: JobTemplateInfo,
    extra?: Record<string, unknown>,
    spec?: SurveyQuestion[],
  ) => {
    if (info.project)
      projects.set(info.project, {
        name: info.project,
        ...(info.scmUrl ? { scm_url: info.scmUrl } : {}),
      });
    const s = survey(spec);
    jobs.set(name, {
      name,
      ...(info.description ? { description: info.description } : {}),
      ...(info.playbook ? { playbook: info.playbook } : {}),
      ...(info.limit ? { limit: info.limit } : {}),
      ...(info.timeout ? { timeout: info.timeout } : {}),
      ...(info.become ? { become_enabled: true } : {}),
      ...(extra ? { extra_vars: scrub(extra) } : {}),
      ...(s ? { survey_enabled: true } : {}),
      ...(info.project ? { project: { name: info.project, type: 'project' } } : {}),
      ...(info.executionEnvironment
        ? {
            execution_environment: {
              name: info.executionEnvironment,
              type: 'execution_environment',
            },
          }
        : {}),
      related: {
        credentials: info.credentials.map((c) => ({
          name: c.name,
          ...(c.kind ? { credential_type: { kind: c.kind } } : {}),
        })),
        ...(s ? { survey_spec: s } : {}),
      },
    });
  };

  const workflow = (w: WorkflowSource) => {
    const s = survey(w.survey);
    workflows.push({
      name: w.name,
      ...(w.description ? { description: w.description } : {}),
      ...(w.extraVars ? { extra_vars: scrub(w.extraVars) } : {}),
      ...(w.limit ? { limit: w.limit } : {}),
      ...(s ? { survey_enabled: true } : {}),
      related: {
        ...(s ? { survey_spec: s } : {}),
        workflow_nodes: w.nodes.map((n) => {
          const refs = (ids: string[]) => ids.map((identifier) => ({ identifier }));
          if (n.kind === 'job' && n.job) job(n.name, n.job);
          if (n.workflow) workflow(n.workflow);
          return {
            identifier: n.identifier,
            unified_job_template:
              n.kind === 'approval' || n.kind === 'missing'
                ? null
                : { name: n.name, type: KIND[n.kind] },
            all_parents_must_converge: n.converge,
            ...(n.extraData ? { extra_data: scrub(n.extraData) } : {}),
            ...(n.limit ? { limit: n.limit } : {}),
            ...(n.jobTags ? { job_tags: n.jobTags } : {}),
            related: {
              success_nodes: refs(n.success),
              failure_nodes: refs(n.failure),
              always_nodes: refs(n.always),
              ...(n.credentials?.length
                ? { credentials: n.credentials.map((name) => ({ name })) }
                : {}),
              ...(n.kind === 'approval'
                ? {
                    create_approval_template: {
                      name: n.name,
                      ...(n.description ? { description: n.description } : {}),
                      timeout: n.timeout ?? 0,
                    },
                  }
                : {}),
            },
          };
        }),
      },
    });
  };

  if (kind === 'job') {
    const node = src.nodes[0];
    if (node?.job)
      job(
        src.name,
        { ...node.job, ...(src.limit ? { limit: src.limit } : {}) },
        src.extraVars,
        src.survey,
      );
  } else workflow(src);
  return {
    ...(workflows.length ? { workflow_job_templates: workflows } : {}),
    job_templates: [...jobs.values()],
    ...(projects.size ? { projects: [...projects.values()] } : {}),
  };
}
