// AFD-7: extract a connected selection into a subflow, in one edit. The engine suite runs the
// flows before and after (test/engine); here: the edit, the refusals, IDs, validity, codegen.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { inputVars } from '../../../src/core/engine/binding';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const schema = createSchemaValidator();
const DATA = 'test/fixtures/engine/data-passing.flow.yaml';
const OS = 'examples/os-upgrade.flow.yaml';
const PORTS = 'test/fixtures/engine/routing-ports.flow.yaml';

function ids(text: string): Set<string> {
  return new Set(text.match(/01[0-9A-HJKMNP-TV-Z]{24}/g));
}
function keyed(doc: FlowDocument, key: string): FlowNode {
  return [...buildModel(doc).nodes.values()].find((n) => n.node.key === key)?.node as FlowNode;
}
function extract(path: string, keys: string[], title = 'Extracted') {
  const text = read(path);
  const doc = parse(text) as FlowDocument;
  const cmd: FlowCommand = {
    kind: 'extractSubflow',
    nodes: keys.map((k) => keyed(doc, k).id),
    title,
    position: { x: 10, y: 20 },
  };
  const r = planCommand(text, cmd, { newId: createIdFactory() });
  const after = parse(r.text) as FlowDocument;
  const sub = buildModel(after).nodes.get(r.created as string)?.node as FlowNode;
  return { text, doc, r, after, sub };
}
/** `from.port -> to` by key, per level. */
function wires(nodes: FlowNode[], edges: FlowDocument['edges'], all: FlowDocument): string[] {
  const key = new Map([...buildModel(all).nodes.values()].map((n) => [n.node.id, n.node.key]));
  void nodes;
  return edges.map((e) => `${key.get(e.from.node)}.${e.from.port} -> ${key.get(e.to.node)}`).sort();
}

describe('extract into a subflow', () => {
  it('moves the group with its IDs; wires in and out end at the subflow; one edit', () => {
    const { text, r, after, sub } = extract(OS, ['backup-config', 'drain-traffic'], 'Prepare');
    expect(applyEdits(text, r.edits)).toBe(r.text);
    // Every ID survives (no exits merged here); the subflow's is the only new one.
    const before = ids(text);
    const now = ids(r.text);
    for (const id of before) expect(now.has(id), id).toBe(true);
    expect([...now].filter((id) => !before.has(id))).toEqual([sub.id]);
    // Both steps are implemented, so is the subflow.
    expect(sub).toMatchObject({
      key: 'prepare',
      type: 'subflow',
      title: 'Prepare',
      status: 'implemented',
    });
    expect(sub.subflow?.nodes?.map((n) => n.key)).toEqual(['backup-config', 'drain-traffic']);
    expect(wires([], sub.subflow?.edges ?? [], after)).toEqual([
      'backup-config.ok_hosts -> drain-traffic',
    ]);
    expect(sub.subflow?.boundary).toEqual({
      in: keyed(after, 'backup-config').id,
      outputs: {
        ok_hosts: [{ node: keyed(after, 'drain-traffic').id, port: 'ok_hosts' }],
        failed_hosts: [{ node: keyed(after, 'drain-traffic').id, port: 'failed_hosts' }],
      },
    });
    const top = wires(after.nodes, after.edges, after);
    expect(top).toContain('change-approval.approved -> prepare');
    expect(top).toContain('prepare.ok_hosts -> upgrade-os');
    expect(top).toContain('prepare.failed_hosts -> notify-on-call');
    expect(top.some((w) => w.startsWith('drain-traffic') || w.endsWith('backup-config'))).toBe(
      false,
    );
    expect(after.layout?.[sub.id]).toEqual({ x: 10, y: 20 });
  });

  it('stays valid, keeps the banner, and the code still compiles', () => {
    const { doc, after } = extract(OS, ['backup-config', 'drain-traffic'], 'Prepare');
    expect(schema(after)).toEqual([]);
    expect(validateFlow(after).findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(openFailPorts(buildModel(after)).length).toBe(openFailPorts(buildModel(doc)).length);
    expect(optionA.generate(after, { source: 'os-upgrade.flow.yaml' }).ok).toBe(true);
  });

  it('outputs read outside are lifted; merged exits keep one wire', () => {
    const { doc, after, sub, text, r } = extract(DATA, ['produce', 'stub'], 'Make data');
    // produce is implemented, stub specified: the subflow is specified (it has outputs).
    expect(sub.status).toBe('specified');
    expect(sub.outputs).toEqual({
      line: { type: 'string', from: 'produce.line' },
      marker: { type: 'string', from: 'stub.marker' },
    });
    expect(keyed(after, 'report').inputs?.said?.from).toBe('make-data.line');
    expect(keyed(after, 'consume').inputs).toMatchObject({
      said: { from: 'make-data.line' },
      tag: { from: 'make-data.marker' },
    });
    // produce and stub both failed to `failed`: one parent wire, the other's ID is gone.
    expect(wires(after.nodes, after.edges, after).filter((w) => w.startsWith('make-data'))).toEqual(
      ['make-data.failed_hosts -> failed', 'make-data.ok_hosts -> report'],
    );
    const now = ids(r.text);
    const gone = [...ids(text)].filter((id) => !now.has(id));
    expect(gone).toHaveLength(1);
    expect(doc.edges.find((e) => e.id === gone[0])?.to.node).toBe(keyed(doc, 'failed').id);
    // Generated code reads the same host variables as before.
    for (const key of ['report', 'consume']) {
      const vars = (d: FlowDocument) => inputVars(buildModel(d), 'root', keyed(d, key));
      expect(vars(after), key).toEqual(vars(doc));
    }
    expect(validateFlow(after).findings.filter((f) => f.code === 'from-unresolved')).toEqual([]);
  });

  it('inside a subflow: nests, and exits of the enclosing one leave through the new subflow', () => {
    const { after, sub } = extract(OS, ['reload', 'wait-for-ssh'], 'Restart');
    const up = keyed(after, 'upgrade-os');
    expect(up.subflow?.nodes?.map((n) => n.key)).toContain('restart');
    expect(up.subflow?.boundary?.outputs?.unreachable).toEqual([
      { node: sub.id, port: 'unreachable' },
    ]);
    expect(sub.ports).toEqual(['unreachable']);
    expect(sub.subflow?.boundary?.outputs).toEqual({
      ok_hosts: [{ node: keyed(after, 'wait-for-ssh').id, port: 'ok_hosts' }],
      unreachable: [{ node: keyed(after, 'wait-for-ssh').id, port: 'unreachable' }],
    });
    expect(schema(after)).toEqual([]);
    expect(validateFlow(after).findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(
      optionA.generate(after, { source: 'os-upgrade.flow.yaml' }).files.map((f) => f.name),
    ).toContain('os-upgrade-edge.upgrade-os.restart.yml');
  });

  it('refuses two ways in, two different exits on one port, gaps, start and end', () => {
    const fail = (path: string, keys: string[]) => () => extract(path, keys);
    expect(fail(PORTS, ['br1', 'br2', 'join'])).toThrow(
      /one way in.*"Branch 1" and "Branch 2"|one way in/,
    );
    expect(fail(PORTS, ['probe', 'work'])).toThrow(/two ok_hosts wires/);
    expect(fail(PORTS, ['probe', 'rollback'])).toThrow(/not connected/);
    expect(fail(PORTS, ['start', 'probe'])).toThrow(/Start and end nodes stay/);
  });
});
