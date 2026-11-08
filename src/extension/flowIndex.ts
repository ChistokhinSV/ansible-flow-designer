// The workspace's flows, read once for every place that shows them (AFD-93, wave 9 group D): the
// Flows view, the Problems panel for flows that are not open, a warning on each generated
// playbook edited by hand, and the flow panel's line about the workspace (round 2: S8, the answer
// to T7 was in the Flows view and nothing led there). Facts per flow are kept until the flow or
// its generated folder changes (`stampOf`); they are read in the background after start-up, two at
// a time, so a large workspace never holds up activation.
import * as vscode from 'vscode';
import { generatedState } from '../core/engine/files';
import {
  type FlowFacts,
  type FlowProblem,
  flowFacts,
  type RepoState,
  repoState,
} from '../core/view/flowFacts';
import { generatedDir, rootFromGenerated } from './codegen';
import type { Host } from './host';
import { VIEW_TYPE } from './host';

const FLOWS = '**/*.flow.yaml';
/** Flows read in the background; past this, the rest when the Flows view shows them. */
const WARM_MAX = 500;
const WARM_DELAY_MS = 3000;
export const EDITED_CODE = 'generated-edited';

/**
 * What a scan of the workspace for flows skips (AFD-155): node_modules and .git, and the plain
 * globs of files.exclude. A string exclude replaces files.exclude, so its globs are folded in;
 * one with braces or a comma of its own cannot go into the list and is left out.
 */
export function flowScanExclude(scope?: vscode.WorkspaceFolder): string {
  const configured =
    vscode.workspace.getConfiguration('files', scope).get<Record<string, unknown>>('exclude') ?? {};
  const plain = Object.entries(configured)
    .filter(([glob, on]) => on === true && !/[{},]/.test(glob))
    .map(([glob]) => glob);
  return `{${[...new Set([...plain, '**/node_modules/**', '**/.git/**'])].join(',')}}`;
}

export interface FlowFile {
  uri: vscode.Uri;
  folder: vscode.WorkspaceFolder;
  /** Path inside its workspace folder, `/`-separated. */
  rel: string;
}

const SEVERITY: Record<FlowProblem['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

async function read(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

async function stampOf(uri: vscode.Uri): Promise<string> {
  const stat = async (u: vscode.Uri) => {
    try {
      return (await vscode.workspace.fs.stat(u)).mtime;
    } catch {
      return 0;
    }
  };
  const dir = generatedDir(uri);
  let generated = 0;
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(dir))
      generated = Math.max(generated, await stat(vscode.Uri.joinPath(dir, name)));
  } catch {}
  return `${await stat(uri)}:${generated}`;
}

const scopeOf = () =>
  vscode.workspace.getConfiguration('afd').get<'workspace' | 'open'>('problems.scope', 'workspace');

export class FlowIndex implements vscode.Disposable {
  /**
   * Facts by flow, under the file's stamp. AFD-154: facts read from an open document with unsaved
   * changes also carry its version: after a Revert or a close without saving, the same stamp must
   * not bring back the facts of text that was thrown away.
   */
  private readonly known = new Map<string, { stamp: string; facts: FlowFacts; dirty?: number }>();
  /** The generated files each flow's warning sits on, to clear them when they are fixed. */
  private readonly warned = new Map<string, vscode.Uri[]>();
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  readonly generatedDiagnostics =
    vscode.languages.createDiagnosticCollection('ansible-flow-generated');
  private files?: Promise<FlowFile[]>;
  private timer?: NodeJS.Timeout;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly host: Host) {
    this.disposables.push(this.changed, this.generatedDiagnostics);
  }

  /** The flows of every workspace folder (files.exclude kept, node_modules skipped). */
  list(): Promise<FlowFile[]> {
    this.files ??= (async () => {
      const out: FlowFile[] = [];
      for (const folder of vscode.workspace.workspaceFolders ?? []) {
        // AFD-155: node_modules and .git are skipped by the walk, not filtered after it.
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, FLOWS),
          flowScanExclude(folder),
        );
        for (const uri of found) {
          if (uri.path.includes('/node_modules/')) continue;
          // Relative to its own folder: the Flows view's tree starts there (AFD-86 used folder 0).
          const rel = vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
          out.push({ uri, folder, rel });
        }
      }
      return out.sort((a, b) => a.uri.toString().localeCompare(b.uri.toString()));
    })();
    return this.files;
  }

  /** A flow's facts, read again when it or its generated folder changed. */
  async facts(uri: vscode.Uri): Promise<FlowFacts> {
    const stamp = await stampOf(uri);
    const key = uri.toString();
    const known = this.known.get(key);
    // An open flow answers from its editor's text, as its Problems do.
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
    const dirty = open?.isDirty ? open.version : undefined;
    if (known?.stamp === stamp && known.dirty === dirty) return known.facts;
    const dir = generatedDir(uri);
    const text = open?.getText() ?? (await read(uri)) ?? '';
    const facts = await flowFacts(
      text,
      this.host.deps.schema,
      {
        read: (name) => read(vscode.Uri.joinPath(dir, name)),
        list: async () => {
          try {
            return (await vscode.workspace.fs.readDirectory(dir))
              .filter(([, type]) => type === vscode.FileType.File)
              .map(([name]) => name);
          } catch {
            return [];
          }
        },
      },
      { source: uri.path.split('/').pop() ?? 'flow.yaml', root: rootFromGenerated(uri) },
    );
    this.known.set(key, { stamp, facts, ...(dirty !== undefined ? { dirty } : {}) });
    await this.publish(uri, facts);
    return facts;
  }

  /** The workspace at a glance, from the flows read so far. */
  async state(): Promise<RepoState> {
    const files = await this.list();
    const read = files.map((f) => this.known.get(f.uri.toString())?.facts).filter(Boolean);
    return repoState(read as FlowFacts[], files.length);
  }

  /**
   * Problems of a flow that is not open (an open one's session publishes its own, richer ones), and
   * the warning on each of its generated playbooks edited by hand.
   */
  private async publish(uri: vscode.Uri, facts: FlowFacts): Promise<void> {
    if (!this.host.sessions.has(uri.toString())) {
      if (scopeOf() === 'workspace')
        this.host.diagnostics.set(
          uri,
          facts.problems.map((p) => {
            const d = new vscode.Diagnostic(
              new vscode.Range(p.start.line, p.start.character, p.end.line, p.end.character),
              p.message,
              SEVERITY[p.severity],
            );
            d.source = 'Ansible Flow';
            d.code = p.code;
            return d;
          }),
        );
      else this.host.diagnostics.delete(uri);
    }
    const old = this.warned.get(uri.toString()) ?? [];
    const now: vscode.Uri[] = [];
    const dir = generatedDir(uri);
    for (const name of facts.kept) {
      const file = vscode.Uri.joinPath(dir, name);
      const text = await read(file);
      // Only our own files: one that is not ours was never written by the designer.
      if (!text || !generatedState(text).ours) continue;
      const d = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, Math.max(1, text.indexOf('\n'))),
        `Edited by hand: saving "${facts.name}" leaves this playbook alone, and Generate Code asks before writing over it.`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.source = 'Ansible Flow';
      d.code = EDITED_CODE;
      d.relatedInformation = [
        new vscode.DiagnosticRelatedInformation(
          new vscode.Location(uri, new vscode.Position(0, 0)),
          `The flow "${facts.name}"`,
        ),
      ];
      this.generatedDiagnostics.set(file, [d]);
      now.push(file);
    }
    for (const file of old)
      if (!now.some((u) => u.toString() === file.toString()))
        this.generatedDiagnostics.delete(file);
    this.warned.set(uri.toString(), now);
  }

  /** A flow's session went away: what the index knows is its Problems again. */
  async republish(uri: vscode.Uri): Promise<void> {
    try {
      await this.publish(uri, await this.facts(uri));
    } catch {}
  }

  /**
   * AFD-155: what the next pass reads. A save or a generated file names its flow; anything else
   * (start-up, a flow created or deleted, settings) reads them all.
   */
  private only?: Set<string>;
  private warming?: Promise<void>;
  private again = false;

  /** Reads the flows a change named, or every flow; one pass at a time, then once more if asked. */
  warm(): Promise<void> {
    if (this.warming) {
      this.again = true;
      return this.warming;
    }
    this.warming = (async () => {
      do {
        this.again = false;
        const only = this.only;
        this.only = undefined;
        await this.pass(only);
      } while (this.again);
    })().finally(() => {
      this.warming = undefined;
    });
    return this.warming;
  }

  /** Reads every flow (up to WARM_MAX), or those in `only`, two at a time; then tells everyone once. */
  private async pass(only?: Set<string>): Promise<void> {
    const all = await this.list();
    const files = (only ? all.filter((f) => only.has(f.uri.toString())) : all).slice(0, WARM_MAX);
    if (!only && all.length > WARM_MAX)
      this.host.log.info(`flows: read the first ${WARM_MAX} in the background; the rest on demand`);
    const queue = [...files];
    const worker = async () => {
      for (let f = queue.shift(); f; f = queue.shift()) {
        try {
          await this.facts(f.uri);
        } catch {}
      }
    };
    await Promise.all([worker(), worker()]);
    this.changed.fire();
  }

  /**
   * Changes come in bursts (a save writes the flow and its playbooks): one pass per burst. A
   * change that names a flow reads that flow only (AFD-155); others read them all.
   */
  private soon(listChanged = false, flow?: vscode.Uri): void {
    if (listChanged) this.files = undefined;
    if (flow && !listChanged) {
      // A full pass already waiting stays full; otherwise this flow joins the next partial one.
      if (this.only !== undefined || !this.timer) {
        this.only ??= new Set();
        this.only.add(flow.toString());
      }
    } else this.only = undefined;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.warm();
    }, 300);
  }

  /** Watches the flows and their generated folders; reads all of them after start-up. */
  start(): vscode.Disposable[] {
    const flows = vscode.workspace.createFileSystemWatcher(FLOWS);
    const code = vscode.workspace.createFileSystemWatcher('**/generated/*.yml');
    const startup = setTimeout(() => void this.warm(), WARM_DELAY_MS);
    return [
      ...this.disposables,
      flows,
      code,
      { dispose: () => clearTimeout(startup) },
      flows.onDidCreate(() => this.soon(true)),
      flows.onDidDelete((u) => {
        this.known.delete(u.toString());
        this.host.diagnostics.delete(u);
        for (const f of this.warned.get(u.toString()) ?? []) this.generatedDiagnostics.delete(f);
        this.warned.delete(u.toString());
        this.soon(true);
      }),
      flows.onDidChange((u) => this.soon(false, u)),
      code.onDidCreate((u) => this.soonFor(u)),
      code.onDidDelete((u) => this.soonFor(u)),
      code.onDidChange((u) => this.soonFor(u)),
      vscode.workspace.onDidSaveTextDocument(
        (d) => d.uri.path.endsWith('.flow.yaml') && this.soon(false, d.uri),
      ),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.soon(true)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('afd.problems.scope')) {
          this.known.clear();
          this.soon();
        }
      }),
      // "Open the Flow" on a generated playbook edited by hand.
      vscode.languages.registerCodeActionsProvider(
        { pattern: '**/generated/*.yml' },
        {
          provideCodeActions: (_doc, _range, context) =>
            context.diagnostics
              .filter((d) => d.code === EDITED_CODE && d.relatedInformation?.[0])
              .map((d) => {
                const flow = d.relatedInformation?.[0]?.location.uri as vscode.Uri;
                const action = new vscode.CodeAction(
                  'Open the Flow',
                  vscode.CodeActionKind.QuickFix,
                );
                action.diagnostics = [d];
                action.command = {
                  command: 'vscode.openWith',
                  title: 'Open the Flow',
                  arguments: [flow, VIEW_TYPE],
                };
                return action;
              }),
        },
        { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
      ),
    ];
  }

  /** A generated file changed: its flows are the ones next to its generated/ folder (AFD-155). */
  private soonFor(generated: vscode.Uri): void {
    const flowDir = vscode.Uri.joinPath(generated, '..', '..').toString();
    void this.list().then((all) => {
      const owners = all.filter((f) => vscode.Uri.joinPath(f.uri, '..').toString() === flowDir);
      if (owners.length === 0) this.soon();
      for (const f of owners) this.soon(false, f.uri);
    });
  }

  /** Forget every flow's facts (Flows view Refresh). */
  clear(): void {
    this.known.clear();
    this.files = undefined;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
