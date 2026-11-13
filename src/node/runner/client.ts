// A client of Ansible Flow Server (AFD-276): the routes the extension's server target uses, as
// the designer's contract with the server names them (contract/server-api.json, AFD-280).
// node:http(s) rather than fetch so TLS verification can be turned off for a lab server, as the
// AWX client does; the token travels only in the Authorization header, to the configured server.
import * as http from 'node:http';
import * as https from 'node:https';
import { cleartextTo } from '../awx/client';
import { TIMEOUTS } from '../timeouts';

export class RunnerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The server's error code (`not_found`, `read_only_token`, …). */
    readonly code?: string,
    /** A launch's problems, by field. */
    readonly problems?: { field?: string; message: string }[],
  ) {
    super(message);
    this.name = 'RunnerError';
  }
}

export interface RunnerMeta {
  name: string;
  version: string;
  api: string;
  designer: { version: string; format: number; formats?: number[]; bundle?: string };
  features?: string[];
}

export interface RunnerProject {
  id: string;
  key: string;
  name: string;
  gitPath: string;
  gitRef: string;
  commit?: string;
}

export interface RunnerConfig {
  id: string;
  name: string;
  flowFile: string;
  mode: 'check' | 'real';
  inventory?: string;
  gitRef?: string;
  commit?: string;
}

/** What a launch would run (the server's PreparedLaunch, without its inputs). */
export interface RunnerLaunch {
  commit: string;
  ref?: string;
  flow: { file: string; key: string; name: string; version: number };
  mode: 'check' | 'real';
  inventory?: string;
  targets: string[];
}

export interface RunnerRun {
  id: string;
  number: number;
  project: string;
  commit: string;
  flow: { file: string; key: string; name: string };
  mode: 'check' | 'real';
  state: 'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'lost';
  error?: string;
  endedAt?: string;
  /** AFD-282: a check run of someone's unpushed work. */
  dev?: true;
}

export interface RunnerGate {
  node: { id: string; key: string; title: string };
  status: string;
  mayDecide: boolean;
  why?: string;
}

export interface LaunchRequest {
  mode?: 'check' | 'real';
  /** AFD-282: a dev bundle's id: the server runs its commit, in check mode. */
  dev?: string;
  limit?: string;
  /** The flow's inputs as typed text, by name. */
  inputs?: Record<string, string>;
}

/** The REST API this client speaks. */
export const RUNNER_API = 'v1';

/** Why this client and the server do not fit for a flow in `format`, or undefined. */
export function incompatible(meta: RunnerMeta, format: number): string | undefined {
  if (meta.name !== 'Ansible Flow Server') return 'The address is not an Ansible Flow Server';
  if (meta.api !== RUNNER_API)
    return `The server speaks API ${meta.api}; this extension speaks ${RUNNER_API}: update the one that is older`;
  const formats = meta.designer.formats ?? [meta.designer.format];
  if (!formats.includes(format))
    return `The flow is in format ${format}; the server (${meta.version}) reads formats ${formats.join(', ')}: upgrade the server`;
  return undefined;
}

export interface RunnerOptions {
  verifyTls?: boolean;
  /** Send the token over plain http to another machine (a lab only). */
  allowHttp?: boolean;
  timeoutMs?: number;
}

const MAX_BODY = 32 * 1024 * 1024;
const enc = encodeURIComponent;

export class RunnerClient {
  readonly base: string;
  private readonly origin: string;

  constructor(
    url: string,
    private readonly token: string,
    private readonly options: RunnerOptions = {},
  ) {
    this.base = url.replace(/\/+$/, '');
    this.origin = new URL(this.base).origin;
  }

  /** A run's page on the server. */
  runUrl(id: string): string {
    return `${this.base}/runs/${enc(id)}`;
  }

  /** The answer's body as text, and its status. */
  private send(
    method: string,
    path: string,
    body?: unknown,
    /** A body sent as it is, with its content type (a git bundle). */
    raw?: { bytes: Buffer; type: string },
  ): Promise<{ status: number; text: string }> {
    const url = new URL(`${this.base}${path}`);
    if (url.origin !== this.origin)
      return Promise.reject(new RunnerError(`Not sending the token to ${url.origin}`));
    if (cleartextTo(url) && !this.options.allowHttp)
      return Promise.reject(
        new RunnerError(
          `Not sending the token unencrypted to ${url.origin}: use an https address, or turn on afd.runner.allowHttp in your user settings (a lab server only)`,
        ),
      );
    const lib = url.protocol === 'https:' ? https : http;
    const data = raw?.bytes ?? (body === undefined ? undefined : JSON.stringify(body));
    const type = raw?.type ?? 'application/json';
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        {
          method,
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: 'application/json',
            ...(data ? { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data) } : {}),
          },
          timeout: this.options.timeoutMs ?? TIMEOUTS.runnerRequest,
          ...(url.protocol === 'https:'
            ? { rejectUnauthorized: this.options.verifyTls !== false }
            : {}),
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on('data', (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
              req.destroy(new Error('the answer is too large'));
              return;
            }
            chunks.push(c);
          });
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
          );
          res.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('no answer in time')));
      req.on('error', (e) =>
        reject(new RunnerError(`The server at ${this.base} does not answer: ${e.message}`)),
      );
      req.end(data);
    });
  }

  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    raw?: { bytes: Buffer; type: string },
  ): Promise<T> {
    const { status, text } = await this.send(method, path, body, raw);
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (status >= 200 && status < 300) return json as T;
    const e = (json ?? {}) as {
      error?: string;
      message?: string;
      problems?: { field?: string; message: string }[];
    };
    const why =
      status === 401
        ? 'The server does not take the token: set it again (it may have expired or been revoked)'
        : status === 413
          ? 'The work is larger than the server takes (AFS_DEV_BUNDLE_MAX_MB)'
          : (e.message ?? `The server answered ${status}`);
    throw new RunnerError(why, status, e.error, e.problems);
  }

  /** The output of a request whose answer is plain text. */
  async text(path: string): Promise<string> {
    const { status, text } = await this.send('GET', path);
    if (status >= 200 && status < 300) return text;
    throw new RunnerError(`The server answered ${status}`, status);
  }

  meta = () => this.request<RunnerMeta>('GET', '/api/v1/meta');
  me = () => this.request<{ login: string; name: string }>('GET', '/api/v1/session');
  projects = (workspace: string) =>
    this.request<RunnerProject[]>('GET', `/api/v1/workspaces/${enc(workspace)}/projects`);
  project = (id: string) => this.request<RunnerProject>('GET', `/api/v1/projects/${enc(id)}`);
  configs = (project: string) =>
    this.request<RunnerConfig[]>('GET', `/api/v1/projects/${enc(project)}/launch-configs`);
  check = async (config: string, req: LaunchRequest) =>
    (
      await this.request<{ launch: RunnerLaunch }>(
        'POST',
        `/api/v1/launch-configs/${enc(config)}/check`,
        req,
      )
    ).launch;
  launch = (config: string, req: LaunchRequest) =>
    this.request<RunnerRun>('POST', `/api/v1/launch-configs/${enc(config)}/launch`, req);
  run = (id: string) => this.request<RunnerRun>('GET', `/api/v1/runs/${enc(id)}`);
  /** How the run went, as the designer shows it (the server's RunView); 404 until it has one. */
  view = async (id: string) => {
    try {
      return await this.request<Record<string, unknown>>('GET', `/api/v1/runs/${enc(id)}/view`);
    } catch (e) {
      if (e instanceof RunnerError && e.status === 404) return undefined;
      throw e;
    }
  };
  gates = (id: string) => this.request<RunnerGate[]>('GET', `/api/v1/runs/${enc(id)}/approvals`);
  cancel = (id: string) => this.request<RunnerRun>('POST', `/api/v1/runs/${enc(id)}/cancel`);
  decide = (id: string, node: string, decision: 'approved' | 'rejected', comment?: string) =>
    this.request<unknown>('POST', `/api/v1/runs/${enc(id)}/approvals/${enc(node)}`, {
      decision,
      ...(comment?.trim() ? { comment: comment.trim() } : {}),
    });
  /** AFD-282: unpushed work for a dev run; resolves with the bundle's id and commit. */
  devBundle = (project: string, bytes: Buffer) =>
    this.request<{ id: string; commit: string; expiresAt: string }>(
      'POST',
      `/api/v1/projects/${enc(project)}/dev-bundles`,
      undefined,
      { bytes, type: 'application/x-git-bundle' },
    );
  /** What one host did in one step of the run. */
  hostOutput = (id: string, node: string, host: string) =>
    this.request<{ entries?: unknown[] }>(
      'GET',
      `/api/v1/runs/${enc(id)}/hosts/${enc(node)}/${enc(host)}`,
    );
}
