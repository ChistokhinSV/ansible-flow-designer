// Copilot's flow tools (AFD-19): the core tools over the workspace as VS Code sees it. They read
// open documents (unsaved changes included) and edit through one WorkspaceEdit, one undo step; the
// file is saved afterwards when it had no unsaved changes before, so the usual save rules (version
// bump, generated/) apply as for any save.
import * as vscode from 'vscode';
import { COPILOT_PREFIX } from '../../core/ai/contributions';
import { type FlowIO, runTool } from '../../core/ai/handlers';
import { type Op, opLabel } from '../../core/ai/ops';
import { TOOL_SPECS, type ToolSpec } from '../../core/ai/specs';
import type { IdFactory } from '../../core/flow/ids';
import type { SchemaValidator } from '../../core/flow/schema';
import { diffEdits } from '../../core/yaml/edits';
import { layoutLevel, shownPositions } from '../autoLayout';
import { authorName } from '../gitHead';

const FLOWS = '**/*.flow.yaml';
const SKIP = '**/{node_modules,.git,generated,out,dist,.vscode-test}/**';

export interface HostToolDeps {
  schema: SchemaValidator;
  newId: IdFactory;
  /** The flow open in the active tab (designer or text), if any. */
  activeFlow(): vscode.Uri | undefined;
  /** Opens a flow the tools created in the designer. */
  open(uri: vscode.Uri): Thenable<unknown>;
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
async function resolve(path: string, mustExist = true): Promise<vscode.Uri> {
  if (!path.endsWith('.flow.yaml')) throw new Error(`${path} is not a flow file (*.flow.yaml)`);
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
  const inside = candidates.filter((u) => vscode.workspace.getWorkspaceFolder(u));
  for (const uri of inside) if (await exists(uri)) return uri;
  if (!mustExist && inside[0]) return inside[0];
  throw new Error(
    inside.length
      ? `No flow ${path}; flow_list shows the flows`
      : `${path} is outside the workspace; tools only touch flows in the open folders`,
  );
}

export function hostFlowIO(deps: HostToolDeps): FlowIO {
  return {
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
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VS Code rejected the edit');
      if (wasDirty)
        return {
          text: doc.getText(),
          notes: ['Not saved: the file had unsaved changes before the edit; the user saves it.'],
        };
      await doc.save();
      return { text: doc.getText(), notes: ['Saved (Ctrl+Z in the editor undoes the edit).'] };
    },
    async create(path, text) {
      const uri = await resolve(path, false);
      if (await exists(uri)) throw new Error(`${path} exists; edit it with flow_edit`);
      await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
      await deps.open(uri);
      return { text, notes: ['Opened in the designer.'] };
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
  };
}

type Input = Record<string, unknown>;

class FlowTool implements vscode.LanguageModelTool<Input> {
  constructor(
    private readonly spec: ToolSpec,
    private readonly io: FlowIO,
  ) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<Input>,
  ): vscode.PreparedToolInvocation {
    const input = options.input ?? {};
    const where = typeof input.path === 'string' ? input.path : 'the open flow';
    const message = `${this.spec.title}: ${where}`;
    if (this.spec.readOnly || input.dry_run === true) return { invocationMessage: message };
    const ops = Array.isArray(input.ops) ? (input.ops as Op[]) : [];
    const detail =
      this.spec.name === 'flow_new'
        ? `Create **${String(input.path)}** ("${String(input.name)}").`
        : this.spec.name === 'flow_complete_ids'
          ? `Add the missing IDs to **${where}** in one edit.`
          : [`Change **${where}**:`, ...ops.slice(0, 20).map((o) => `- ${opLabel(o)}`)].join('\n');
    return {
      invocationMessage: message,
      confirmationMessages: {
        title: `${this.spec.title}?`,
        message: new vscode.MarkdownString(
          `${detail}\n\nOne undo step; saved when the file had no unsaved changes.`,
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
