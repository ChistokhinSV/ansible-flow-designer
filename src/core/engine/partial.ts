// AFD-244: the flow a partial run executes. "Run from Here" starts the hosts at a top-level step
// instead of the flow's first one; "Run This Step" runs that step alone. The flow is trimmed the
// way Delete trims it (no healing: the steps before are not passed through, they are not there):
// the start node is wired to the chosen step and the steps the run does not reach are taken out.
// A step that read an output of a step taken out would find no value, so it runs as its TODO
// stub, and the run says which steps those are. Skeleton runs only (product-owner decision): a
// real run on part of a flow could act on data that was never made.
import { parse, stringify } from 'yaml';
import { type FlowCommand, planCommand } from '../flow/commands';
import { CONTINUES_ON } from '../flow/heal';
import { createIdFactory } from '../flow/ids';
import { buildModel, ROOT } from '../flow/model';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import { descendantIds } from '../flow/walk';

export interface PartialRun {
  /** The step the hosts start at. */
  node: Ulid;
  /** Run that step alone. */
  only: boolean;
}

export interface PartialFlow {
  doc: FlowDocument;
  /** How many top-level steps the run leaves out. */
  skipped: number;
  /** Steps run as stubs because they read a step that is left out, with what they read. */
  stubbed: { node: Ulid; title: string; reads: string[] }[];
}

/** Why a partial run cannot start at this node, or undefined when it can. */
export function partialProblem(doc: FlowDocument, node: Ulid): string | undefined {
  const model = buildModel(doc);
  const entry = model.nodes.get(node);
  if (!entry) return 'No such node';
  if (entry.level !== ROOT) return 'A run starts at a step of the top level: open the top level';
  if (entry.node.type === 'start' || entry.node.type === 'end')
    return 'A run starts at a step, not at a start or end node';
  if (!(model.levels.get(ROOT)?.nodes ?? []).some((n) => n?.type === 'start'))
    return 'The flow has no start node';
  return undefined;
}

// IDs for the wires made for the run only; the flow file never sees them.
const noIds = { newId: createIdFactory() };

export function partialFlow(doc: FlowDocument, run: PartialRun): PartialFlow | { error: string } {
  const problem = partialProblem(doc, run.node);
  if (problem) return { error: problem };
  const model = buildModel(doc);
  const root = model.levels.get(ROOT);
  const nodes = (root?.nodes ?? []).filter((n): n is FlowNode => !!n?.id);
  const edges = (root?.edges ?? []).filter((e) => !!e?.from && !!e.to);
  const start = nodes.find((n) => n.type === 'start') as FlowNode;
  const target = model.nodes.get(run.node)?.node as FlowNode;

  // What the run reaches: the step alone, or everything after it.
  const reached = new Set<Ulid>([run.node]);
  if (!run.only)
    for (const stack = [run.node]; stack.length > 0; ) {
      const at = stack.pop() as Ulid;
      for (const e of edges)
        if (e.from.node === at && !reached.has(e.to.node)) {
          reached.add(e.to.node);
          stack.push(e.to.node);
        }
    }
  const skipped = nodes.filter((n) => n.id !== start.id && n.type !== 'end' && !reached.has(n.id));

  const cmds: FlowCommand[] = [];
  // The steps left out go first: the wire that is then made from Start cannot close a loop.
  if (skipped.length > 0) cmds.push({ kind: 'deleteNodes', ids: skipped.map((n) => n.id) });
  let text = stringify(doc);
  try {
    for (const c of cmds) text = planCommand(text, c, noIds).text;
    // Start now leads to the chosen step, and nowhere else.
    for (;;) {
      const now = buildModel(parse(text) as FlowDocument).levels.get(ROOT);
      const out = (now?.edges ?? []).find((e) => e?.from?.node === start.id);
      if (!out) break;
      if (out.to.node === run.node && out.to.port === 'in') break;
      text = planCommand(text, { kind: 'disconnect', edge: out.id }, noIds).text;
    }
    const wired = buildModel(parse(text) as FlowDocument).levels.get(ROOT);
    if (!(wired?.edges ?? []).some((e) => e?.from?.node === start.id)) {
      text = planCommand(
        text,
        {
          kind: 'connect',
          from: { node: start.id, port: 'ok_hosts' },
          to: { node: run.node, port: 'in' },
        },
        noIds,
      ).text;
    }
    // One step alone: its hosts go on to a successful end, when the flow has one.
    if (run.only) {
      const now = buildModel(parse(text) as FlowDocument).levels.get(ROOT);
      const port = CONTINUES_ON[target.type];
      const end = (now?.nodes ?? []).find((n) => n?.type === 'end' && n.outcome !== 'failed');
      const free =
        port && !(now?.edges ?? []).some((e) => e?.from?.node === run.node && e.from.port === port);
      if (port && end && free)
        text = planCommand(
          text,
          { kind: 'connect', from: { node: run.node, port }, to: { node: end.id, port: 'in' } },
          noIds,
        ).text;
    }
  } catch (e) {
    return {
      error: `The flow cannot be trimmed for this run: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const out = parse(text) as FlowDocument;
  // A field that read a step left out has lost its `from` (deleteNodes): its step runs as a stub.
  const before = model;
  const after = buildModel(out);
  const stubbed: PartialFlow['stubbed'] = [];
  for (const { node } of after.nodes.values()) {
    const was = before.nodes.get(node.id)?.node;
    if (!was) continue;
    const reads = Object.entries(was.inputs ?? {})
      .filter(([name, f]) => !!f?.from && !node.inputs?.[name]?.from)
      .map(([, f]) => f?.from as string);
    if (reads.length === 0) continue;
    // A subflow hands its inputs to the steps inside it: they are stubs too.
    const inside = new Set([node.id, ...descendantIds(node)]);
    let any = false;
    for (const id of inside) {
      const n = after.nodes.get(id)?.node;
      if (n?.impl) {
        delete (n as { impl?: unknown }).impl;
        any = true;
      }
    }
    if (any) stubbed.push({ node: node.id, title: node.title, reads });
  }
  return { doc: out, skipped: skipped.length, stubbed };
}

/** "from Validate" or "Validate alone", with what was left out, for the run's panel. */
export function partialLine(title: string, only: boolean, flow: PartialFlow): string {
  const what = only ? `Ran "${title}" alone` : `Ran from "${title}"`;
  const left = flow.skipped
    ? `; ${flow.skipped} step${flow.skipped === 1 ? '' : 's'} before it did not run`
    : '';
  const stubs = flow.stubbed.length
    ? `. As stubs, since they read a step that did not run: ${flow.stubbed.map((s) => s.title).join(', ')}`
    : '';
  return `${what}${left}${stubs}`;
}
