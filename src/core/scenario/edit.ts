// The scenarios file as a document (AFD-115): what the canvas and the flow tools do to
// `<flow key>.scenarios.yaml`, as byte-preserving edits through YamlTransaction, like commands.ts
// does for a flow. Each command is one edit, so one undo; comments and the rest of the file stay.
// A first scenario creates the file. Names a scenario by its name, steps by key path.
import type { FlowDocument } from '../flow/types';
import { applyEdits, type TextEdit } from '../yaml/edits';
import { deleteKey, insertItem, removeItem, setIn } from '../yaml/ops';
import type { Path } from '../yaml/parse';
import { FlowList, renderBlock, type YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { type Forced, type Scenario, type ScenarioFile, targetsInput } from './scenarios';

export type ApprovalPick = 'approved' | 'rejected' | 'timeout';

export type ScenarioCommand =
  | { kind: 'add'; scenario: Scenario; at?: number }
  | { kind: 'rename'; name: string; to: string }
  | { kind: 'duplicate'; name: string; to: string }
  | { kind: 'delete'; name: string }
  /** AFD-117: the whole scenario written anew (the flow tools' update); comments in it go. */
  | { kind: 'replace'; name: string; scenario: Scenario }
  /** The hosts to run on; a host taken out loses its expectation and forced outcomes. */
  | { kind: 'setHosts'; name: string; hosts: string[] }
  /** The hosts sent down `outcome` at `step` (key path); none removes the entry. */
  | { kind: 'force'; name: string; step: string; outcome: Forced; hosts: string[] }
  /** The outcome an approval takes for the run; none goes back to approved. */
  | { kind: 'setApproval'; name: string; approval: string; pick?: ApprovalPick }
  /** Every expectation at once (from the simulation: Accept New Ends). */
  | { kind: 'setExpect'; name: string; expect: Record<string, string> }
  | { kind: 'expectHost'; name: string; host: string; where: string };

/**
 * What the designer asks for (AFD-116): a command, or one the host completes from the simulation.
 * `add` with no expectations gets where the simulation sends its hosts; `acceptEnds` writes them.
 */
export type ScenarioRequest = ScenarioCommand | { kind: 'acceptEnds'; name: string };

export class ScenarioEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioEditError';
  }
}

export interface ScenarioEdit {
  text: string;
  edits: TextEdit[];
  /** The file did not exist: `text` is all of it. */
  created: boolean;
}

/** A list of names on one line, as the hand-written files have them. */
const hosts = (list: readonly string[]) => new FlowList(list);
const listsInline = (map: Record<string, unknown>): Record<string, YamlValue> =>
  Object.fromEntries(
    Object.entries(map).map(([k, v]) => [
      k,
      Array.isArray(v) && v.every((x) => typeof x !== 'object') ? hosts(v) : (v as YamlValue),
    ]),
  );

/** A scenario in the file's own key order; host lists on one line. */
function render(s: Scenario): YamlValue {
  const out: Record<string, YamlValue> = { name: s.name };
  if (s.inputs && Object.keys(s.inputs).length) out.inputs = listsInline(s.inputs);
  if (s.groups && Object.keys(s.groups).length) out.groups = listsInline(s.groups);
  if (s.force && Object.keys(s.force).length)
    out.force = Object.fromEntries(
      Object.entries(s.force).map(([step, ports]) => [step, listsInline(ports ?? {})]),
    );
  if (s.approvals && Object.keys(s.approvals).length) out.approvals = s.approvals as YamlValue;
  out.expect = (s.expect ?? {}) as YamlValue;
  return out;
}

/**
 * A new file: what it is, the flow it belongs to, and its first scenario, with the list indented
 * as the hand-written files are (later edits keep the style they find).
 */
export function newScenariosText(
  doc: FlowDocument,
  first: Scenario,
  eol: '\n' | '\r\n' = '\n',
): string {
  return [
    `# Scenario tests for flow ${doc.flow.key}: where each host must end when chosen steps fail.`,
    '# The designer writes this file (Scenarios in the side panel); it can be edited by hand too.',
    `flow: ${doc.flow.key}`,
    'scenarios:',
    ...renderBlock([render(first)], 2, { eol, indentUnit: 2, seqIndentless: false }),
    '',
  ].join(eol);
}

const scenariosOf = (tx: YamlTransaction): Scenario[] => {
  const file = tx.current.doc.toJS() as ScenarioFile | null;
  return Array.isArray(file?.scenarios) ? file.scenarios : [];
};

function indexOf(list: Scenario[], name: string): number {
  const i = list.findIndex((s) => s?.name === name);
  if (i < 0) throw new ScenarioEditError(`No scenario named "${name}"`);
  return i;
}

function unique(list: Scenario[], name: string): void {
  if (!name.trim()) throw new ScenarioEditError('Give the scenario a name');
  if (list.some((s) => s?.name === name))
    throw new ScenarioEditError(`A scenario named "${name}" is already there`);
}

/** Removes a key, and its map when that was the last key in it (down to the scenario). */
function prune(tx: YamlTransaction, path: Path, key: string, stop: number): void {
  let at = path;
  let name = key;
  for (;;) {
    const map = valueAt(tx, at) as Record<string, unknown> | undefined;
    if (!map || !(name in map)) return;
    if (Object.keys(map).length > 1 || at.length <= stop) {
      tx.apply((f) => deleteKey(f, at, name));
      return;
    }
    name = String(at.at(-1));
    at = at.slice(0, -1);
  }
}

function valueAt(tx: YamlTransaction, path: Path): unknown {
  let v: unknown = tx.current.doc.toJS();
  for (const k of path) v = (v as Record<string | number, unknown> | null | undefined)?.[k];
  return v;
}

/**
 * The scenarios file after `cmd`. `text` is undefined when the file does not exist yet; only `add`
 * creates it. Throws ScenarioEditError for a command that does not fit the file.
 */
export function planScenarioEdit(
  text: string | undefined,
  cmd: ScenarioCommand,
  doc: FlowDocument,
): ScenarioEdit {
  if (text === undefined) {
    if (cmd.kind !== 'add') throw new ScenarioEditError('This flow has no scenarios yet');
    unique([], cmd.scenario.name);
    return { text: newScenariosText(doc, cmd.scenario), edits: [], created: true };
  }
  const tx = new YamlTransaction(text);
  const list = scenariosOf(tx);
  const at = (i: number, ...rest: (string | number)[]): Path => ['scenarios', i, ...rest];
  switch (cmd.kind) {
    case 'add': {
      unique(list, cmd.scenario.name);
      tx.apply((f) => insertItem(f, ['scenarios'], cmd.at ?? 'end', render(cmd.scenario)));
      break;
    }
    case 'rename': {
      const i = indexOf(list, cmd.name);
      if (cmd.to === cmd.name) break;
      unique(list, cmd.to);
      tx.apply((f) => setIn(f, at(i, 'name'), cmd.to));
      break;
    }
    case 'duplicate': {
      const i = indexOf(list, cmd.name);
      unique(list, cmd.to);
      const copy = structuredClone(list[i] as Scenario);
      tx.apply((f) => insertItem(f, ['scenarios'], i + 1, render({ ...copy, name: cmd.to })));
      break;
    }
    case 'delete': {
      const i = indexOf(list, cmd.name);
      tx.apply((f) => removeItem(f, ['scenarios'], i));
      break;
    }
    case 'replace': {
      const i = indexOf(list, cmd.name);
      if (cmd.scenario.name !== cmd.name)
        unique(
          list.filter((_, j) => j !== i),
          cmd.scenario.name,
        );
      tx.apply((f) => setIn(f, ['scenarios', i], render(cmd.scenario)));
      break;
    }
    case 'setHosts': {
      const i = indexOf(list, cmd.name);
      const input = targetsInput(doc) ?? 'devices';
      tx.apply((f) => setIn(f, at(i, 'inputs', input), hosts(cmd.hosts)));
      const keep = new Set(cmd.hosts);
      const s = list[i] as Scenario;
      for (const host of Object.keys(s.expect ?? {}))
        if (!keep.has(host)) tx.apply((f) => deleteKey(f, at(i, 'expect'), host));
      for (const [step, ports] of Object.entries(s.force ?? {}))
        for (const [outcome, was] of Object.entries(ports ?? {})) {
          if (!Array.isArray(was) || was.every((h) => keep.has(h))) continue;
          const left = was.filter((h) => keep.has(h));
          if (left.length) tx.apply((f) => setIn(f, at(i, 'force', step, outcome), hosts(left)));
          else prune(tx, at(i, 'force', step), outcome, 2);
        }
      break;
    }
    case 'force': {
      const i = indexOf(list, cmd.name);
      if (cmd.hosts.length)
        tx.apply((f) => setIn(f, at(i, 'force', cmd.step, cmd.outcome), hosts(cmd.hosts)));
      else prune(tx, at(i, 'force', cmd.step), cmd.outcome, 2);
      break;
    }
    case 'setApproval': {
      const i = indexOf(list, cmd.name);
      if (cmd.pick && cmd.pick !== 'approved')
        tx.apply((f) => setIn(f, at(i, 'approvals', cmd.approval), cmd.pick as string));
      else prune(tx, at(i, 'approvals'), cmd.approval, 2);
      break;
    }
    case 'setExpect': {
      const i = indexOf(list, cmd.name);
      tx.apply((f) => setIn(f, at(i, 'expect'), cmd.expect));
      break;
    }
    case 'expectHost': {
      const i = indexOf(list, cmd.name);
      tx.apply((f) => setIn(f, at(i, 'expect', cmd.host), cmd.where));
      break;
    }
  }
  return { text: tx.text, edits: tx.edits(), created: false };
}

/** Applies a plan's edits to the text it was planned on (tests, the file system IO). */
export const applyScenarioEdit = (text: string, e: ScenarioEdit) =>
  e.created ? e.text : applyEdits(text, e.edits);
