// Copilot's flow tools (AFD-19): the core tools over the workspace as VS Code sees it. They read
// open documents (unsaved changes included) and edit through one WorkspaceEdit, one undo step; the
// file is saved afterwards when it had no unsaved changes before, so the usual save rules (version
// bump, generated/) apply as for any save.
import * as vscode from 'vscode';
import { COPILOT_PREFIX } from '../../core/ai/contributions';
import { type FlowIO, runTool } from '../../core/ai/handlers';
import { type Op, opLabel } from '../../core/ai/ops';
import { isSourceFile, SKIP_GLOB, SOURCE_MAX_BYTES } from '../../core/ai/sourceRules';
import { TOOL_SPECS, type ToolSpec } from '../../core/ai/specs';
import { parseFlow } from '../../core/flow/document';
import type { IdFactory } from '../../core/flow/ids';
import type { SchemaValidator } from '../../core/flow/schema';
import { normalize, type SourceIO } from '../../core/import/read';
import { type ScenarioResult, scenariosFileName } from '../../core/scenario/scenarios';
import { diffEdits } from '../../core/yaml/edits';
import { layoutLevel, shownPositions } from '../../node/autoLayout';
import { CMD } from '../commands/ids';
import { authorName } from '../gitHead';
import { stillInside, workspaceSource } from '../import/common';
import { followScenarios } from '../run/scenarioFollow';

const FLOWS = '**/*.flow.yaml';
const SKIP = SKIP_GLOB;

export interface HostToolDeps {
  schema: SchemaValidator;
  newId: IdFactory;
  /** The flow open in the active tab (designer or text), if any. */
  activeFlow(): vscode.Uri | undefined;
  /** Opens a flow the tools created in the designer. */
  open(uri: vscode.Uri): Thenable<unknown>;
  /** AFD-27: short module names → FQCN from the folder's catalog, when one is loaded. */
  resolveModule?(
    folder: vscode.WorkspaceFolder,
  ): ((name: string, collections: string[]) => string | undefined) | undefined;
}

/** Whether a file of the folder really lies inside it (a symlink may point elsewhere). */
/**
 * A workspace folder's Ansible files for the tools: inside the folder only (through symlinks too),
 * read-only, the same kinds and sizes the MCP server reads (AFD-37, core/ai/sourceRules).
 */
function toolSource(folder: vscode.WorkspaceFolder): SourceIO {
  const io = workspaceSource(folder);
  const ok = (path: string) => !normalize(path).startsWith('..');
  return {
    read: async (path) => {
      if (!ok(path) || !isSourceFile(path) || !(await stillInside(folder, path))) return undefined;
      try {
        const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder.uri, path));
        if (stat.size > SOURCE_MAX_BYTES) return undefined;
      } catch {
        return undefined;
      }
      return io.read(path);
    },
    list: async (dir) => (ok(dir) ? io.list(dir) : []),
    exists: async (path) => ok(path) && (await exists(vscode.Uri.joinPath(folder.uri, path))),
  };
}

const multiRoot = () => (vscode.workspace.workspaceFolders?.length ?? 0) > 1;
const relative = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, multiRoot());

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

/** A tool's path as a URI inside the workspace; anything else is refused. */
async function resolve(path: string, mustExist = true, exportFile = false): Promise<vscode.Uri> {
  if (exportFile && !/\.(drawio|svg)$/i.test(path))
    throw new Error(`${path}: exports are .drawio or .svg files`);
  if (!exportFile && !path.endsWith('.flow.yaml'))
    throw new Error(`${path} is not a flow file (*.flow.yaml)`);
  const folders = vscode.workspace.workspaceFolders ?? [];
  const candidates = /^([a-zA-Z]:[\\/]|\/)/.test(path)
    ? [vscode.Uri.file(path)]
    : folders.flatMap((f) => {
        const [first, ...rest] = path.split(/[\\/]/);
        return [
          vscode.Uri.joinPath(f.uri, path),
          ...(first === f.name && rest.length ? [vscode.Uri.joinPath(f.uri, ...rest)] : []),
        ];
      });
  // AFD-137: inside a folder by path, and still inside once links are resolved.
  const inside: vscode.Uri[] = [];
  for (const u of candidates) {
    const folder = vscode.workspace.getWorkspaceFolder(u);
    if (folder && (await stillInside(folder, vscode.workspace.asRelativePath(u, false))))
      inside.push(u);
  }
  for (const uri of inside) if (await exists(uri)) return uri;
  if (!mustExist && inside[0]) return inside[0];
  throw new Error(
    inside.length
      ? `No flow ${path}; flow_list shows the flows`
      : `${path} is outside the workspace; tools only touch flows in the open folders`,
  );
}

/** AFD-117: the scenarios file next to a flow; its open document when it has one. */
async function scenariosOf(
  path: string,
  key: string,
): Promise<{ uri: vscode.Uri; text?: string; doc?: vscode.TextDocument }> {
  const uri = vscode.Uri.joinPath(await resolve(path), '..', scenariosFileName(key));
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc) return { uri, text: doc.getText(), doc };
  try {
    return { uri, text: new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) };
  } catch {
    return { uri };
  }
}

export function hostFlowIO(deps: HostToolDeps): FlowIO {
  let sourceFolder: vscode.WorkspaceFolder | undefined;
  return {
    async readScenarios(path, key) {
      return (await scenariosOf(path, key)).text;
    },
    async writeScenarios(path, key, before, after) {
      const s = await scenariosOf(path, key);
      if (s.text !== before)
        throw new Error('the scenarios file changed while the tool worked; list them again');
      const edit = new vscode.WorkspaceEdit();
      const doc =
        s.doc ??
        (before === undefined ? undefined : await vscode.workspace.openTextDocument(s.uri));
      if (!doc) edit.createFile(s.uri, { contents: new TextEncoder().encode(after) });
      else
        for (const e of diffEdits(before ?? '', after))
          edit.replace(
            s.uri,
            new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
            e.newText,
          );
      const wasDirty = doc?.isDirty ?? false;
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit');
      if (wasDirty)
        return ['Not saved: the scenarios file had unsaved changes; the user saves it.'];
      if (doc) await doc.save();
      return ['Saved.'];
    },
    async verifyScenarios(path, names) {
      const results = await vscode.commands.executeCommand<ScenarioResult[] | undefined>(
        CMD.runScenarios,
        await resolve(path),
        names,
      );
      return results ?? 'The scenarios did not run: the notification in VS Code says why';
    },
    async list() {
      const uris = await vscode.workspace.findFiles(FLOWS, SKIP, 500);
      return uris.map(relative).sort();
    },
    current() {
      const uri = deps.activeFlow();
      return uri?.path.endsWith('.flow.yaml') ? relative(uri) : undefined;
    },
    async read(path) {
      return (await vscode.workspace.openTextDocument(await resolve(path))).getText();
    },
    async write(path, before, after) {
      const uri = await resolve(path);
      const doc = await vscode.workspace.openTextDocument(uri);
      if (doc.getText() !== before)
        throw new Error('the file changed while the tool worked; describe it again');
      const wasDirty = doc.isDirty;
      const edit = new vscode.WorkspaceEdit();
      for (const e of diffEdits(before, after))
        edit.replace(
          uri,
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
          e.newText,
        );
      // AFD-115: steps renamed or moved are renamed in the flow's scenarios file too.
      const follow = await followScenarios(uri, parseFlow(before).doc, parseFlow(after).doc).catch(
        () => undefined,
      );
      follow?.apply(edit);
      const followed = follow ? [`Scenarios updated: ${follow.notes.join(', ')}.`] : [];
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit');
      if (wasDirty)
        return {
          text: doc.getText(),
          notes: [
            'Not saved: the file had unsaved changes before the edit; the user saves it.',
            ...followed,
          ],
        };
      // Saving the flow saves a scenarios file its edit changed (saveFollowed).
      await doc.save();
      return {
        text: doc.getText(),
        notes: ['Saved (Ctrl+Z in the editor undoes the edit).', ...followed],
      };
    },
    async create(path, text) {
      const uri = await resolve(path, false);
      if (await exists(uri)) throw new Error(`${path} exists; edit it with flow_edit`);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
      await deps.open(uri);
      return { text, notes: ['Opened in the designer.'] };
    },
    async writeExport(path, text) {
      const uri = await resolve(path, false, true);
      await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, '..'));
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
      return relative(uri);
    },
    ops(path) {
      return {
        newId: deps.newId,
        author: async () => {
          try {
            return await authorName(await resolve(path));
          } catch {
            return undefined;
          }
        },
        layout: layoutLevel,
        positions: shownPositions,
      };
    },
    schema: deps.schema,
    source(path) {
      const folders = vscode.workspace.workspaceFolders ?? [];
      const [first, ...rest] = path.split(/[\\/]/);
      const named = folders.length > 1 ? folders.find((f) => f.name === first) : undefined;
      const folder = named ?? folders[0];
      if (!folder) return undefined;
      sourceFolder = folder;
      return {
        io: toolSource(folder),
        path: named ? rest.join('/') : path,
        prefix: named ? `${first}/` : folders.length > 1 ? `${folder.name}/` : '',
      };
    },
    resolveModule(name, collections) {
      // The folder the import reads from (multi-root), else the first one.
      const folder = sourceFolder ?? vscode.workspace.workspaceFolders?.[0];
      return folder ? deps.resolveModule?.(folder)?.(name, collections) : undefined;
    },
  };
}

type Input = Record<string, unknown>;

/**
 * AFD-165: what a flow_scenarios call does, per action. list and check only read, so they ask
 * nothing; add, update and delete write the scenarios file next to the flow; verify runs
 * ansible-playbook in the run environment (every step as its stub).
 */
export function scenariosConfirmation(
  input: Record<string, unknown>,
  where: string,
  invocationMessage: string,
): vscode.PreparedToolInvocation {
  const action = typeof input.action === 'string' ? input.action : 'list';
  const name = typeof input.name === 'string' ? ` "${input.name}"` : '';
  const file = `the scenarios file of **${where}**`;
  const detail: Record<string, string> = {
    add: `Add the scenario${name} to ${file}. One undo step; the flow itself does not change.`,
    update: `Change the scenario${name} in ${file}. One undo step; the flow itself does not change.`,
    delete: `Delete the scenario${name} from ${file}. One undo step; the flow itself does not change.`,
    verify: `Run ${typeof input.names === 'object' && Array.isArray(input.names) ? `${input.names.length} scenario(s)` : 'every scenario'} of **${where}** with ansible-playbook in your run environment. Every step runs as its stub on local-connection hosts, so nothing reaches a device; it can take minutes.`,
  };
  const text = detail[action];
  if (!text) return { invocationMessage };
  return {
    invocationMessage,
    confirmationMessages: {
      title: action === 'verify' ? 'Verify Scenarios in Ansible?' : 'Edit Scenarios?',
      message: new vscode.MarkdownString(text),
    },
  };
}

class FlowTool implements vscode.LanguageModelTool<Input> {
  constructor(
    private readonly spec: ToolSpec,
    private readonly io: FlowIO,
  ) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
  ): vscode.PreparedToolInvocation {
    const input = options.input ?? {};
    const where =
      typeof input.path === 'string'
        ? input.path
        : this.spec.name === 'source_outline' || this.spec.name === 'flow_import'
          ? String(input.source ?? '')
          : 'the open flow';
    const message = `${this.spec.title}: ${where}`;
    if (this.spec.readOnly || input.dry_run === true) return { invocationMessage: message };
    // AFD-165: flow_scenarios reads (list, check), writes the scenarios file (add, update,
    // delete) or runs Ansible (verify); the generic "Change <flow>" said none of that.
    if (this.spec.name === 'flow_scenarios') return scenariosConfirmation(input, where, message);
    const ops = Array.isArray(input.ops) ? (input.ops as Op[]) : [];
    const detail =
      this.spec.name === 'flow_new'
        ? `Create **${String(input.path)}** ("${String(input.name)}").`
        : this.spec.name === 'flow_complete_ids'
          ? `Add the missing IDs to **${where}** in one edit.`
          : this.spec.name === 'flow_export'
            ? `Write a ${input.format === 'svg' ? 'SVG image' : 'draw.io diagram'} of **${where}**${typeof input.out === 'string' ? ` to **${input.out}**` : ' next to it'}.`
            : this.spec.name === 'flow_import'
              ? `Create **${typeof input.path === 'string' ? input.path : 'a new flow under flows/'}** from **${String(input.source)}**${typeof input.template === 'string' ? ` (${input.template})` : ''}, one step per task.`
              : [`Change **${where}**:`, ...ops.slice(0, 20).map((o) => `- ${opLabel(o)}`)].join(
                  '\n',
                );
    return {
      invocationMessage: message,
      confirmationMessages: {
        title: `${this.spec.title}?`,
        message: new vscode.MarkdownString(
          this.spec.name === 'flow_export'
            ? `${detail}\n\nThe flow itself does not change; an existing file there is replaced.`
            : this.spec.name === 'flow_import'
              ? `${detail}\n\nThe source is only read; nothing existing changes.`
              : `${detail}\n\nOne undo step; saved when the file had no unsaved changes.`,
        ),
      },
    };
  }

  async invoke(options: vscode.LanguageModelToolInvocationOptions<Input>) {
    const result = await runTool(this.io, this.spec.name, options.input);
    // A thrown error reaches the model as the tool's answer, marked as failed.
    if (result.isError) throw new Error(result.text);
    return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(result.text)]);
  }
}

export function registerFlowTools(io: FlowIO): vscode.Disposable[] {
  return TOOL_SPECS.map((spec) =>
    vscode.lm.registerTool(`${COPILOT_PREFIX}${spec.name}`, new FlowTool(spec, io)),
  );
}
