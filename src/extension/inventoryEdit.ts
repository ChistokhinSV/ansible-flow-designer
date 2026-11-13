// AFD-259, AFD-260: the Inventory view's edit actions. Each asks what it needs, has the pure
// engine (core/inventory/edit) write the smallest change into the files' text, and saves: the view
// reads again on the save. What is not written as plain names (a range, a dynamic source, a
// vaulted value) is refused with the reason, and can be opened as text.
import * as vscode from 'vscode';
import {
  editInventory,
  groupNameProblem,
  hostNameProblem,
  type InventoryOp,
  parseValue,
  removeVarInFile,
  setVarInFile,
  showValue,
  varNameProblem,
  written,
} from '../core/inventory/edit';
import {
  type InventoryFiles,
  type ShownVar,
  targetVars,
  varPlace,
  varRenames,
} from './inventoryFiles';

/** What the commands get from the view: its items carry these. */
export type EditTarget =
  /** `parent`: the group it is shown under (absent at the top level). */
  | { kind: 'group'; group: { name: string }; parent?: string }
  | { kind: 'host'; host: string; group?: string }
  | { kind: 'var'; variable: ShownVar; host?: string; group?: string };

export interface EditContext {
  folder(): vscode.Uri | undefined;
  /** The inventory's files as they are on disk now. */
  files(): Promise<InventoryFiles | undefined>;
  /** Group names of the inventory as Ansible reads it, for lists to pick from. */
  groups(): string[];
}

/** Ansible's own groups: every host is in `all`; `ungrouped` holds hosts in no other group. */
const BUILT_IN = new Set(['all', 'ungrouped']);

interface Write {
  path: string;
  text: string;
}

/**
 * Writes whole files (new ones too) and saves them, so runs and the view see them. A file open in
 * an editor is changed there, so Undo takes it back; one with unsaved changes is not touched.
 */
export async function writeInventoryFiles(
  at: vscode.Uri,
  writes: Write[],
  renames: [string, string][] = [],
) {
  if (!writes.length && !renames.length) return true;
  const open = (uri: vscode.Uri) =>
    vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const dirty = writes.find((w) => open(vscode.Uri.joinPath(at, w.path))?.isDirty);
  if (dirty) {
    void vscode.window.showErrorMessage(
      `${dirty.path} has unsaved changes: save it first, then change the inventory from the view.`,
    );
    return false;
  }
  // Renames first: a file written below may be one that was just renamed.
  if (renames.length) {
    const edit = new vscode.WorkspaceEdit();
    for (const [from, to] of renames)
      edit.renameFile(vscode.Uri.joinPath(at, from), vscode.Uri.joinPath(at, to));
    if (!(await vscode.workspace.applyEdit(edit))) {
      void vscode.window.showErrorMessage('The variables files could not be renamed.');
      return false;
    }
  }
  for (const w of writes) {
    const uri = vscode.Uri.joinPath(at, w.path);
    const doc = open(uri);
    const onDisk = await vscode.workspace.fs.readFile(uri).then(
      (bytes) => new TextDecoder().decode(bytes),
      () => undefined,
    );
    // Through the editor only when it shows what is on disk: a document VS Code has not read
    // again yet (the file changed outside) would refuse the save.
    if (doc && onDisk !== undefined && doc.getText() === onDisk) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), w.text);
      if (!(await vscode.workspace.applyEdit(edit)) || !(await doc.save())) {
        void vscode.window.showErrorMessage(`${w.path} could not be changed.`);
        return false;
      }
      continue;
    }
    if (onDisk === undefined && w.path.includes('/'))
      await vscode.workspace.fs.createDirectory(
        vscode.Uri.joinPath(at, w.path.slice(0, w.path.lastIndexOf('/'))),
      );
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(w.text));
  }
  return true;
}

/** The groups to pick from: as Ansible reads them, and those the files write. */
async function groupNames(ctx: EditContext): Promise<string[]> {
  const files = await ctx.files();
  return [...new Set([...ctx.groups(), ...(files?.texts ?? []).flatMap((f) => written(f).groups)])];
}

/** Runs one change through the engine; asks for the file when a new group could go to several. */
async function change(ctx: EditContext, op: InventoryOp, renames: [string, string][] = []) {
  const at = ctx.folder();
  const files = await ctx.files();
  if (!at || !files) return false;
  let result = editInventory(files.texts, op);
  if (!result.ok && result.choose && op.op === 'add_group') {
    const file = await vscode.window.showQuickPick(result.choose, {
      title: `Add Group ${op.group}`,
      placeHolder: 'The file that holds the new group',
    });
    if (!file) return false;
    result = editInventory(files.texts, { ...op, file });
  }
  if (!result.ok) {
    void vscode.window.showErrorMessage(result.error);
    return false;
  }
  return writeInventoryFiles(at, result.files, renames);
}

const ask = (
  title: string,
  prompt: string,
  value: string,
  check: (v: string) => string | undefined,
) =>
  vscode.window.showInputBox({
    title,
    prompt,
    value,
    ignoreFocusOut: true,
    validateInput: (v) => check(v.trim()),
  });

async function addHost(ctx: EditContext, item?: EditTarget) {
  let group = item?.kind === 'group' ? item.group.name : undefined;
  if (!group) {
    group = await vscode.window.showQuickPick(
      (await groupNames(ctx)).filter((g) => g !== 'all'),
      { title: 'Add Host', placeHolder: 'The group the host goes to' },
    );
    if (!group) return false;
  }
  const host = await ask(
    `Add Host to ${group}`,
    'The host name, as the inventory and the flows name it.',
    '',
    hostNameProblem,
  );
  if (!host) return false;
  // AFD-262: the address is asked with the host, not left to be found as a variable.
  const address = await ask(
    `Add Host to ${group}: ${host.trim()}`,
    'Its address: an IP address or a DNS name (ansible_host). Leave it empty when the host name itself resolves.',
    '',
    addressProblem,
  );
  if (address === undefined) return false;
  if (!(await change(ctx, { op: 'add_host', host: host.trim(), group }))) return false;
  return address.trim() ? setAddressOf(ctx, host.trim(), address.trim()) : true;
}

/** An IP address or a DNS name; empty is allowed where the box says so. */
function addressProblem(v: string): string | undefined {
  if (!v) return undefined;
  return /^[A-Za-z0-9_.:-]+$/.test(v) ? undefined : 'An IP address or a DNS name, without spaces';
}

/** Writes ansible_host where it is written already, else where a new variable goes. */
async function setAddressOf(ctx: EditContext, host: string, address: string): Promise<boolean> {
  const files = await ctx.files();
  if (!files) return false;
  const target = { host };
  const now = targetVars(files, target).find((v) => v.key === 'ansible_host');
  const file = now && !now.inline ? files.varFiles.find((f) => f.path === now.file) : undefined;
  if (now?.vaulted) {
    void vscode.window.showInformationMessage(
      `The address of ${host} is vault-encrypted in ${now.file}: change it with ansible-vault.`,
    );
    return false;
  }
  if (!address) {
    if (!now) return true;
    return removeVar(ctx, { kind: 'var', variable: now, host });
  }
  let place: { inline: true } | { file: string; text?: string };
  if (now) place = file ? { file: file.path, text: file.text } : { inline: true };
  else {
    // A new host has no variables yet, so the rule gives one place; if it would ask, the
    // address goes on the host's line, beside its other variables there.
    const rule = varPlace(files, target);
    place = 'ask' in rule ? rule.ask[1] : rule;
  }
  return setVar(ctx, target, 'ansible_host', address, place);
}

/** AFD-262: Set Address… on a host: its IP address or DNS name in one step. */
async function setAddress(ctx: EditContext, item?: EditTarget) {
  const files = await ctx.files();
  if (!files || item?.kind !== 'host') return false;
  const now = targetVars(files, { host: item.host }).find((v) => v.key === 'ansible_host');
  const address = await ask(
    `Address of ${item.host}`,
    'An IP address or a DNS name (ansible_host). Empty: the host name itself is used.',
    now && !now.vaulted && typeof now.value === 'string' ? now.value : '',
    addressProblem,
  );
  return address === undefined ? false : setAddressOf(ctx, item.host, address.trim());
}

/** Add Group… (the view's title): a group at the top level, whatever is selected. */
const addGroup = (ctx: EditContext) => addGroupUnder(ctx);
/** Add Child Group… (on a group): a group under that one. */
const addChildGroup = (ctx: EditContext, item?: EditTarget) => addGroupUnder(ctx, item);

async function addGroupUnder(ctx: EditContext, item?: EditTarget) {
  const parent = item?.kind === 'group' && item.group.name !== 'all' ? item.group.name : undefined;
  const known = await groupNames(ctx);
  const group = await ask(
    parent ? `Add Group under ${parent}` : 'Add Group',
    'The group name: letters, digits and underscores.',
    '',
    (v) =>
      groupNameProblem(v) ?? (known.includes(v) && !parent ? `${v} is there already` : undefined),
  );
  if (!group) return false;
  const name = group.trim();
  // AFD-262: one change. The engine makes a child where its parent is (and, in INI, its section):
  // a group made at the top first showed twice in a YAML inventory.
  return parent
    ? change(ctx, { op: 'add_group', group: name, parent })
    : change(ctx, { op: 'add_group', group: name });
}

async function rename(ctx: EditContext, item?: EditTarget) {
  const files = await ctx.files();
  if (!files || !item || item.kind === 'var') return false;
  if (item.kind === 'host') {
    const to = await ask(
      `Rename ${item.host}`,
      'The new host name, in every group it is in.',
      item.host,
      (v) => (v === item.host ? 'Enter another name' : hostNameProblem(v)),
    );
    if (!to) return false;
    return change(
      ctx,
      { op: 'rename_host', host: item.host, to: to.trim() },
      varRenames(files, 'host', item.host, to.trim()),
    );
  }
  const from = item.group.name;
  if (BUILT_IN.has(from)) {
    void vscode.window.showInformationMessage(
      `${from} is Ansible's own group: it has no other name.`,
    );
    return false;
  }
  const to = await ask(
    `Rename ${from}`,
    'The new group name, wherever it is written. Playbooks and flows that target the group by name are not changed.',
    from,
    (v) => (v === from ? 'Enter another name' : groupNameProblem(v)),
  );
  if (!to) return false;
  return change(
    ctx,
    { op: 'rename_group', group: from, to: to.trim() },
    varRenames(files, 'group', from, to.trim()),
  );
}

async function remove(ctx: EditContext, item?: EditTarget) {
  if (!item) return false;
  if (item.kind === 'var') return removeVar(ctx, item);
  if (item.kind === 'host') {
    const group = item.group && item.group !== 'all' ? item.group : undefined;
    const yes = group ? `Remove from ${group}` : 'Remove from the Inventory';
    const picked = await vscode.window.showWarningMessage(
      group
        ? `Remove ${item.host} from ${group}? Its lines in other groups and its variables files stay.`
        : `Remove ${item.host} from every group of the inventory? Its variables files stay.`,
      { modal: true },
      yes,
    );
    return picked === yes ? change(ctx, { op: 'remove_host', host: item.host, group }) : false;
  }
  const name = item.group.name;
  if (BUILT_IN.has(name)) {
    void vscode.window.showInformationMessage(
      `${name} is Ansible's own group: it cannot be deleted.`,
    );
    return false;
  }
  const picked = await vscode.window.showWarningMessage(
    `Delete the group ${name}? Its hosts are removed from it (they stay in their other groups), with the variables written for it in the inventory. Its variables files stay.`,
    { modal: true },
    'Delete Group',
  );
  return picked === 'Delete Group' ? change(ctx, { op: 'remove_group', group: name }) : false;
}

/** AFD-262: a group, with everything in it, under another group or to the top level. */
async function moveGroup(ctx: EditContext, item: Extract<EditTarget, { kind: 'group' }>) {
  const name = item.group.name;
  if (BUILT_IN.has(name)) {
    void vscode.window.showInformationMessage(
      `${name} is Ansible's own group: it stays where it is.`,
    );
    return false;
  }
  const from = item.parent && item.parent !== 'all' ? item.parent : undefined;
  const TOP = 'The Top Level';
  const picked = await vscode.window.showQuickPick(
    [
      ...(from ? [{ label: TOP, description: 'not inside another group' }] : []),
      ...(await groupNames(ctx))
        .filter((g) => !BUILT_IN.has(g) && g !== name && g !== from)
        .map((label) => ({ label, description: 'becomes its parent group' })),
    ],
    {
      title: `Move the Group ${name}`,
      placeHolder: from ? `From ${from} to` : 'From the top level to',
    },
  );
  if (!picked) return false;
  return change(ctx, {
    op: 'move_group',
    group: name,
    ...(from ? { from } : {}),
    ...(picked.label === TOP ? {} : { to: picked.label }),
  });
}

async function moveHost(ctx: EditContext, item?: EditTarget) {
  if (item?.kind === 'group') return moveGroup(ctx, item);
  if (item?.kind !== 'host') return false;
  const from = item.group;
  if (!from || from === 'all') {
    void vscode.window.showInformationMessage(
      'Open the host under the group it is in to move it from there.',
    );
    return false;
  }
  const to = await vscode.window.showQuickPick(
    (await groupNames(ctx)).filter((g) => g !== 'all' && g !== from),
    { title: `Move ${item.host}`, placeHolder: `From ${from} to` },
  );
  return to ? change(ctx, { op: 'move_host', host: item.host, from, to }) : false;
}

const targetOf = (item: EditTarget) =>
  item.kind === 'host'
    ? { host: item.host }
    : item.kind === 'group'
      ? { group: item.group.name }
      : item.host
        ? { host: item.host }
        : { group: item.group };

/** Where a new variable goes: the shared rule, and a question when both places are in use. */
async function placeFor(
  files: InventoryFiles,
  target: { host?: string; group?: string },
): Promise<{ inline: true } | { file: string; text?: string } | undefined> {
  const place = varPlace(files, target);
  if (!('ask' in place)) return place;
  const [inFile, inline] = place.ask;
  const name = (target.host ?? target.group) as string;
  const picked = await vscode.window.showQuickPick(
    [
      { label: inFile.file, description: 'the variables file', place: inFile },
      {
        label: 'The inventory file',
        description: 'beside its other variables there',
        place: inline,
      },
    ],
    { title: `Add Variable to ${name}`, placeHolder: 'Both are in use here: where does it go?' },
  );
  return picked?.place;
}

async function setVar(
  ctx: EditContext,
  target: { host?: string; group?: string },
  key: string,
  value: unknown,
  place: { inline: true } | { file: string; text?: string },
) {
  const at = ctx.folder();
  if (!at) return false;
  if ('inline' in place) return change(ctx, { op: 'set_var', ...target, key, value });
  const text = setVarInFile(place.text, key, value);
  if (typeof text !== 'string') {
    void vscode.window.showErrorMessage(text.error);
    return false;
  }
  return writeInventoryFiles(at, [{ path: place.file, text }]);
}

async function addVar(ctx: EditContext, item?: EditTarget) {
  const files = await ctx.files();
  if (!files || !item || item.kind === 'var') return false;
  const target = targetOf(item);
  const name = (target.host ?? target.group) as string;
  const known = targetVars(files, target).map((v) => v.key);
  const key = await ask(`Add Variable to ${name}`, 'The variable name.', '', (v) =>
    known.includes(v) ? `${v} is set already: edit its value` : varNameProblem(v),
  );
  if (!key) return false;
  const typed = await ask(
    `${name}: ${key.trim()}`,
    'The value, as it would be in YAML: text, a number, true or false, a list [a, b], a mapping {k: v}.',
    '',
    () => undefined,
  );
  if (typed === undefined) return false;
  const place = await placeFor(files, target);
  return place ? setVar(ctx, target, key.trim(), parseValue(typed), place) : false;
}

async function editVar(ctx: EditContext, item?: EditTarget) {
  const files = await ctx.files();
  if (!files || item?.kind !== 'var') return false;
  const v = item.variable;
  if (v.vaulted) {
    void vscode.window.showInformationMessage(
      `${v.key} is vault-encrypted: change it with ansible-vault (encrypt_string), in ${v.file}.`,
    );
    return false;
  }
  const target = targetOf(item);
  const name = (target.host ?? target.group) as string;
  const typed = await ask(
    `${name}: ${v.key}`,
    'The value, as it would be in YAML: text, a number, true or false, a list [a, b], a mapping {k: v}.',
    showValue(v),
    () => undefined,
  );
  if (typed === undefined) return false;
  const file = files.varFiles.find((f) => f.path === v.file);
  return setVar(
    ctx,
    target,
    v.key,
    parseValue(typed),
    v.inline || !file ? { inline: true } : { file: file.path, text: file.text },
  );
}

async function removeVar(ctx: EditContext, item: Extract<EditTarget, { kind: 'var' }>) {
  const at = ctx.folder();
  const files = await ctx.files();
  if (!at || !files) return false;
  const v = item.variable;
  const target = targetOf(item);
  if (v.inline) return change(ctx, { op: 'remove_var', ...target, key: v.key });
  const file = files.varFiles.find((f) => f.path === v.file);
  if (!file) return false;
  const text = removeVarInFile(file.text, v.key);
  if (typeof text !== 'string') {
    void vscode.window.showErrorMessage(text.error);
    return false;
  }
  return writeInventoryFiles(at, [{ path: file.path, text }]);
}

export function registerInventoryEdits(ctx: EditContext): vscode.Disposable[] {
  const on = (id: string, run: (ctx: EditContext, item?: EditTarget) => Promise<boolean>) =>
    vscode.commands.registerCommand(id, (item?: EditTarget) => run(ctx, item));
  return [
    on('afd.inventory.addHost', addHost),
    on('afd.inventory.addGroup', addGroup),
    on('afd.inventory.addChildGroup', addChildGroup),
    on('afd.inventory.setAddress', setAddress),
    on('afd.inventory.rename', rename),
    on('afd.inventory.remove', remove),
    on('afd.inventory.moveHost', moveHost),
    on('afd.inventory.addVar', addVar),
    on('afd.inventory.editVar', editVar),
  ];
}
