// Settings → environment (ADR-0005, decision 6) and one probe session per repository and
// environment, restarted when the settings change.
import * as vscode from 'vscode';
import { insidePaths, probeProcess } from '../../core/run/command';
import {
  type AfdEnvSettings,
  type EnvironmentResult,
  type RedHatSettings,
  resolveEnvironment,
} from '../../core/run/environment';
import { ProbeClient } from '../../node/env/probeClient';

/** Why nothing runs in Restricted Mode: the repository's ansible.cfg, plugins and playbooks are code. */
export const UNTRUSTED =
  'This workspace is not trusted, so Ansible Flow does not start Ansible or the probe here: trust the workspace to run flows, lenses and the module catalog';

export function environmentFor(scope: vscode.Uri): EnvironmentResult {
  if (!vscode.workspace.isTrusted) return { ok: false, error: UNTRUSTED };
  const c = vscode.workspace.getConfiguration('afd', scope);
  const afd: AfdEnvSettings = {
    kind: c.get('environment.kind', 'auto'),
    containerEngine: c.get('environment.containerEngine', 'auto'),
    image: c.get('environment.image', ''),
    containerOptions: c.get<string[]>('environment.containerOptions', []),
    python: c.get('environment.python', ''),
    wslDistro: c.get('environment.wslDistro', ''),
  };
  // Soft relationship with redhat.ansible: its settings are defaults when ours are unset.
  const a = vscode.workspace.getConfiguration('ansible', scope);
  const redhat: RedHatSettings = {
    eeEnabled: a.get<boolean>('executionEnvironment.enabled'),
    image: a.get<string>('executionEnvironment.image'),
    containerEngine: a.get<string>('executionEnvironment.containerEngine'),
    containerOptions: a.get<string>('executionEnvironment.containerOptions'),
    volumeMounts: a.get<RedHatSettings['volumeMounts']>('executionEnvironment.volumeMounts'),
    interpreterPath: a.get<string>('python.interpreterPath'),
  };
  return resolveEnvironment(afd, redhat, process.platform);
}

/**
 * What a probe process is for (AFD-32): catalog dumps can take minutes, so they get their own
 * process and never hold up the lenses, Re-sync or a run's inventory check.
 */
export type ProbePurpose = 'main' | 'catalog';

export class ProbeManager implements vscode.Disposable {
  private readonly clients = new Map<string, ProbeClient>();
  private seq = 0;

  constructor(
    private readonly probeDir: string,
    /** Catalog cache on this machine (global storage), mounted into containers (M5). */
    private readonly cacheDir?: string,
    /** Where probe lifecycle and stderr lines go. */
    private readonly log: (line: string) => void = () => {},
  ) {}

  private keyOf(folder: vscode.Uri, purpose: ProbePurpose, env: unknown): string {
    return `${folder.toString()}|${purpose}|${JSON.stringify(env)}`;
  }

  /**
   * The probe for a repository folder in the configured environment (started lazily); `cache` is
   * the catalog cache as the probe sees it.
   */
  forFolder(
    folder: vscode.Uri,
    purpose: ProbePurpose = 'main',
  ): { client: ProbeClient; label: string; cache?: string } | { error: string } {
    const resolved = environmentFor(folder);
    if (!resolved.ok) return { error: resolved.error };
    const env = resolved.env;
    const paths = { root: folder.fsPath, probe: this.probeDir, cache: this.cacheDir };
    const key = this.keyOf(folder, purpose, env);
    let client = this.clients.get(key);
    if (!client) {
      const spec = probeProcess(env, paths, `afd-probe-${process.pid}-${++this.seq}`);
      const inside = env.kind === 'local' ? undefined : insidePaths(env, paths).root;
      client = new ProbeClient(spec, folder.fsPath, inside, this.log);
      this.clients.set(key, client);
    }
    const cache = this.cacheDir && insidePaths(env, paths).cache;
    return { client, label: env.label, cache };
  }

  /** Stops a folder's probe of this purpose (a catalog probe once its dump is done). */
  release(folder: vscode.Uri, purpose: ProbePurpose): void {
    const prefix = `${folder.toString()}|${purpose}|`;
    for (const [key, client] of this.clients)
      if (key.startsWith(prefix)) {
        client.dispose();
        this.clients.delete(key);
      }
  }

  dispose(): void {
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}
