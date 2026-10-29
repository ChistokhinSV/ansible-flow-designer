// The subset of the AWX REST API (v2) Run mode uses (M7, ADR-0013). Pure types.

export interface AwxPage<T> {
  count: number;
  next: string | null;
  results: T[];
}

export interface AwxNamed {
  id: number;
  name: string;
}

export type AwxJobStatus =
  | 'new'
  | 'pending'
  | 'waiting'
  | 'running'
  | 'successful'
  | 'failed'
  | 'error'
  | 'canceled';

export const FINISHED: ReadonlySet<AwxJobStatus> = new Set([
  'successful',
  'failed',
  'error',
  'canceled',
]);

export interface AwxJob extends AwxNamed {
  status: AwxJobStatus;
  failed: boolean;
  started: string | null;
  finished: string | null;
  elapsed: number;
  /** The commit the project update checked out for this job. */
  scm_revision: string;
  job_template: number | null;
  inventory: number | null;
  /** Why it did not run (no capacity, project update failed …). */
  job_explanation: string;
}

export interface AwxJobEvent {
  id: number;
  counter: number;
  event: string;
  event_data: {
    host?: string;
    task?: string;
    play?: string;
    task_action?: string;
    ignore_errors?: boolean;
    res?: Record<string, unknown>;
  };
  failed: boolean;
  changed: boolean;
  host_name: string;
  play: string;
  task: string;
  created: string;
}

export interface AwxJobTemplate extends AwxNamed {
  project: number | null;
  playbook: string;
  inventory: number | null;
  execution_environment: number | null;
  ask_variables_on_launch: boolean;
}

export interface AwxProject extends AwxNamed {
  scm_type: string;
  scm_url: string;
  scm_branch: string;
  status: string;
}

/** What "Set up AWX template" writes (decision M7-3). */
export interface TemplateSpec {
  name: string;
  description: string;
  project: number;
  playbook: string;
  inventory: number;
  execution_environment?: number;
  credentials: number[];
}
