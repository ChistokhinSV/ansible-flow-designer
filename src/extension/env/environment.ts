// Settings → environment (ADR-0005, decision 6) and one probe session per repository and
// environment, restarted when the settings change.
import * as vscode from 'vscode';
import { probeProcess } from '../../core/run/command';
import {
  type AfdEnvSettings,
  type EnvironmentResult,
  type RedHatSettings,
  resolveEnvironment,
} from '../../core/run/environment';
import { ProbeClient } from './probeClient';

export function environmentFor(scope: vscode.Uri): EnvironmentResult {
  const c = vscode.workspace.getConfiguration('afd', scope);
  const afd: AfdEnvSettings = {
    kind: c.get('environment.kind', 'auto'),
    containerEngine: c.get('environment.containerEngine', 'auto'),
    image: c.get('environment.image', ''),
    containerOptions: c.get<string[]>('environment.containerOptions', []),
    python: c.get('environment.python', ''),
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

export class ProbeManager implements vscode.Disposable {
  private readonly clients = new Map<string, ProbeClient>();
  private seq = 0;

  constructor(private readonly probeDir: string) {}

  /** The probe for a repository folder in the configured environment (started lazily). */
  forFolder(folder: vscode.Uri): { client: ProbeClient; label: string } | { error: string } {
    const resolved = environmentFor(folder);
    if (!resolved.ok) return { error: resolved.error };
    const env = resolved.env;
    const key = `${folder.toString()}|${JSON.stringify(env)}`;
    let client = this.clients.get(key);
    if (!client) {
      const spec = probeProcess(
        env,
        { root: folder.fsPath, probe: this.probeDir },
        `afd-probe-${process.pid}-${++this.seq}`,
      );
      client = new ProbeClient(spec, folder.fsPath, env.kind === 'container');
      this.clients.set(key, client);
    }
    return { client, label: env.label };
  }

  dispose(): void {
    for (const c of this.clients.values()) c.dispose();
    this.clients.clear();
  }
}
