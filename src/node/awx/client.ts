// AWX REST client (M7, ADR-0013): bearer token, JSON, pagination, per-client TLS verification.
// node:http(s) rather than fetch so verification can be turned off for a lab without a CA.
// The token only ever travels in the Authorization header: errors never echo request headers.
import * as http from 'node:http';
import * as https from 'node:https';
import type { AwxSurveySpec } from '../../core/awx/survey';
import type {
  AwxJob,
  AwxJobEvent,
  AwxJobTemplate,
  AwxNamed,
  AwxPage,
  TemplateSpec,
} from '../../core/awx/types';
import { TIMEOUTS } from '../timeouts';

const PAGE = 200;

export class AwxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The socket error code when AWX could not be reached (ECONNRESET, …). */
    readonly code?: string,
  ) {
    super(message);
    this.name = 'AwxError';
  }
}

/**
 * Errors a second try fixes: a kept-alive socket the server (or the tunnel in front of it) closed
 * while idle, which the next request then hits (AFD-32).
 */
const STALE_SOCKET = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED']);

export interface AwxOptions {
  verifyTls?: boolean;
  /** Idle time without data before a request fails. */
  timeoutMs?: number;
  /** AFD-161: the whole request, however slowly the data comes. */
  deadlineMs?: number;
  /**
   * AFD-161: send the token over plain http. Refused by default, except to this machine
   * (localhost, 127.0.0.1, ::1), where nothing crosses a network.
   */
  allowHttp?: boolean;
  /** The largest answer read (default MAX_BODY_BYTES). */
  maxBodyBytes?: number;
}

/** AFD-161: no AWX answer is larger than this; a bigger one is a misbehaving proxy or server. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** AFD-161: 500 pages of 200 is 100,000 items, more than any AWX list Ansible Flow reads. */
export const MAX_PAGES = 500;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Whether a URL would carry the token over plain http to another machine. */
export const cleartextTo = (url: URL) => url.protocol === 'http:' && !LOOPBACK.has(url.hostname);

/** AWX's validation errors are `{field: ["message"]}` or `{detail: "message"}`. */
function describe(body: unknown): string {
  if (!body || typeof body !== 'object') return String(body ?? '').slice(0, 300);
  const o = body as Record<string, unknown>;
  if (typeof o.detail === 'string') return o.detail;
  return Object.entries(o)
    .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(' ') : String(v)}`)
    .join('; ')
    .slice(0, 300);
}

export class AwxClient {
  readonly base: string;
  private readonly origin: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly options: AwxOptions = {},
  ) {
    this.base = url.replace(/\/+$/, '');
    this.origin = new URL(this.base).origin;
  }

  /** The AWX UI page of a job's output. */
  jobUrl(id: number): string {
    return `${this.base}/#/jobs/playbook/${id}/output`;
  }

  request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.base}${path}`);
    // The token goes to the configured AWX only (AFD-29), whatever a response points to.
    if (url.origin !== this.origin)
      return Promise.reject(new AwxError(`Not sending the AWX token to ${url.origin}`));
    if (cleartextTo(url) && !this.options.allowHttp)
      return Promise.reject(
        new AwxError(
          `Not sending the AWX token unencrypted to ${url.origin}: use an https address, or turn on afd.awx.allowHttp in your user settings (a lab AWX only)`,
        ),
      );
    const lib = url.protocol === 'https:' ? https : http;
    const data = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<T>((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(data
              ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
              : {}),
          },
          timeout: this.options.timeoutMs ?? TIMEOUTS.awxRequest,
          ...(url.protocol === 'https:'
            ? { rejectUnauthorized: this.options.verifyTls !== false }
            : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          const max = this.options.maxBodyBytes ?? MAX_BODY_BYTES;
          res.on('data', (c: Buffer) => {
            if (size > max) return;
            size += c.length;
            if (size > max) {
              // The error reaches the caller here: a body read whole in one chunk still ends.
              clearTimeout(deadline);
              reject(
                new AwxError(
                  `AWX answered ${url.pathname} with more than ${max} bytes: stopped reading`,
                ),
              );
              req.destroy();
              return;
            }
            chunks.push(c);
          });
          res.on('end', () => {
            clearTimeout(deadline);
            if (size > max) return;
            const text = Buffer.concat(chunks).toString('utf8');
            let parsed: unknown = text;
            try {
              parsed = text ? JSON.parse(text) : undefined;
            } catch {
              // Not JSON (a proxy error page): reported as text.
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) resolve(parsed as T);
            else if (status === 401)
              reject(
                new AwxError(
                  'AWX refused the token (401): set a new one with "Set AWX Token"',
                  status,
                ),
              );
            else
              reject(
                new AwxError(
                  `AWX ${method} ${url.pathname} failed (${status}): ${describe(parsed)}`,
                  status,
                ),
              );
          });
        },
      );
      req.on('timeout', () =>
        req.destroy(new AwxError(`AWX did not answer ${url.pathname} in time`)),
      );
      // AFD-161: the idle timeout above restarts with every chunk; this ends a slow trickle too.
      const deadline = setTimeout(
        () => req.destroy(new AwxError(`AWX did not finish ${url.pathname} in time`)),
        this.options.deadlineMs ?? TIMEOUTS.awxRequestTotal,
      );
      req.on('error', (e: NodeJS.ErrnoException) => {
        clearTimeout(deadline);
        reject(
          e instanceof AwxError
            ? e
            : new AwxError(`Cannot reach AWX at ${this.base}: ${e.message}`, undefined, e.code),
        );
      });
      if (data) req.write(data);
      req.end();
    });
  }

  /** A GET is safe to repeat, so a stale kept-alive socket gets one more try. */
  async get<T>(path: string): Promise<T> {
    try {
      return await this.request<T>('GET', path);
    } catch (e) {
      if (!(e instanceof AwxError) || !e.code || !STALE_SOCKET.has(e.code)) throw e;
      return this.request<T>('GET', path);
    }
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('PATCH', path, body);
  }

  /** Every page of a list endpoint. */
  async all<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}page_size=${PAGE}`;
    // AFD-161: a `next` that comes round again, or no end at all, would loop for good.
    const seen = new Set<string>();
    while (next) {
      if (seen.has(next))
        throw new AwxError(`AWX's pages of ${path} lead back to ${next}: stopped reading`);
      if (seen.size >= MAX_PAGES)
        throw new AwxError(`AWX's list ${path} has more than ${MAX_PAGES} pages: stopped reading`);
      seen.add(next);
      const page: AwxPage<T> = await this.get<AwxPage<T>>(next);
      out.push(...page.results);
      // AWX answers with a path; an absolute `next` (a proxy rewriting hosts) is followed on the
      // configured AWX, so the token never leaves it.
      if (!page.next) next = null;
      else {
        const url = new URL(page.next, `${this.base}/`);
        next = `${this.origin}${url.pathname}${url.search}`;
      }
    }
    return out;
  }

  async ping(): Promise<{ version: string }> {
    return this.get('/api/v2/ping/');
  }

  async named<T extends AwxNamed>(kind: string, name: string): Promise<T | undefined> {
    const page = await this.get<AwxPage<T>>(`/api/v2/${kind}/?name=${encodeURIComponent(name)}`);
    return page.results.find((r) => r.name === name);
  }

  list<T extends AwxNamed>(kind: string): Promise<T[]> {
    return this.all<T>(`/api/v2/${kind}/?order_by=name`);
  }

  /** Creates the job template or updates the one of the same name; credentials are set to the list. */
  async upsertTemplate(spec: TemplateSpec): Promise<AwxJobTemplate> {
    const body = {
      name: spec.name,
      description: spec.description,
      job_type: 'run',
      project: spec.project,
      playbook: spec.playbook,
      inventory: spec.inventory,
      execution_environment: spec.execution_environment ?? null,
      ask_variables_on_launch: true,
      ask_limit_on_launch: true,
    };
    const existing = await this.named<AwxJobTemplate>('job_templates', spec.name);
    const jt = existing
      ? await this.patch<AwxJobTemplate>(`/api/v2/job_templates/${existing.id}/`, body)
      : await this.post<AwxJobTemplate>('/api/v2/job_templates/', body);
    const current = await this.all<AwxNamed>(`/api/v2/job_templates/${jt.id}/credentials/`);
    for (const c of current)
      if (!spec.credentials.includes(c.id))
        await this.post(`/api/v2/job_templates/${jt.id}/credentials/`, {
          id: c.id,
          disassociate: true,
        });
    for (const id of spec.credentials)
      if (!current.some((c) => c.id === id))
        await this.post(`/api/v2/job_templates/${jt.id}/credentials/`, { id });
    return jt;
  }

  /** A template's survey (AFD-59); `kind` is job_templates or workflow_job_templates. */
  async survey(kind: string, id: number): Promise<Partial<AwxSurveySpec> | undefined> {
    const spec = await this.get<Partial<AwxSurveySpec>>(`/api/v2/${kind}/${id}/survey_spec/`);
    return spec && Object.keys(spec).length > 0 ? spec : undefined;
  }

  /** Writes the survey and turns it on: launches then ask its questions. */
  async setSurvey(kind: string, id: number, spec: AwxSurveySpec): Promise<void> {
    await this.post(`/api/v2/${kind}/${id}/survey_spec/`, spec);
    await this.patch(`/api/v2/${kind}/${id}/`, { survey_enabled: true });
  }

  async launch(templateId: number, extraVars: Record<string, unknown>): Promise<AwxJob> {
    const r = await this.post<{ job: number }>(`/api/v2/job_templates/${templateId}/launch/`, {
      extra_vars: extraVars,
    });
    return this.job(r.job);
  }

  job(id: number): Promise<AwxJob> {
    return this.get<AwxJob>(`/api/v2/jobs/${id}/`);
  }

  /** Events after `counter`, in order (incremental polling while a job runs). */
  events(jobId: number, counter: number): Promise<AwxJobEvent[]> {
    return this.all<AwxJobEvent>(
      `/api/v2/jobs/${jobId}/job_events/?order_by=counter&counter__gt=${counter}`,
    );
  }

  async cancel(jobId: number): Promise<void> {
    await this.post(`/api/v2/jobs/${jobId}/cancel/`, {});
  }

  async cancelWorkflow(workflowJobId: number): Promise<void> {
    await this.post(`/api/v2/workflow_jobs/${workflowJobId}/cancel/`, {});
  }
}

/**
 * Following an AWX job stopped before it finished (AFD-29): the user cancelled the progress, or it
 * ran past the follow limit. The job itself keeps running in AWX.
 */
export class StoppedFollowing extends Error {
  constructor(
    readonly kind: 'job' | 'workflow',
    readonly id: number,
    readonly url: string,
    timedOut: boolean,
  ) {
    super(
      timedOut
        ? `Stopped following AWX ${kind} ${id} after ${FOLLOW_HOURS} hours: it keeps running in AWX`
        : `Stopped following AWX ${kind} ${id}: it keeps running in AWX`,
    );
    this.name = 'StoppedFollowing';
  }
}

/** How long a launch follows a job or workflow before it stops polling (it can be stopped sooner). */
export const FOLLOW_HOURS = 12;

/** A follow loop's stop check: cancelled by the user, or past the follow limit. */
export function followLimit(cancelled: () => boolean, start = Date.now()) {
  return (): 'cancelled' | 'timeout' | undefined =>
    cancelled()
      ? 'cancelled'
      : Date.now() - start > FOLLOW_HOURS * 3600_000
        ? 'timeout'
        : undefined;
}
