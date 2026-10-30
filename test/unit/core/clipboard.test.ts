// AFD-17: nodes copied as YAML text and pasted as new nodes, in one edit: in the same flow, another
// flow, or a subflow; from a copy or from a snippet written by hand.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import {
  CLIP_HEADER,
  type Clip,
  copyNodes,
  looksLikeNodes,
  parseClip,
} from '../../../src/core/flow/clipboard';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';

const ROOT = join(__dirname, '../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const schema = createSchemaValidator();
const EDGE = read('examples/edge-baseline.flow.yaml');
const OS = read('examples/os-upgrade.flow.yaml');

function ids(text: string): Set<string> {
  return new Set(text.match(/01[0-9A-HJKMNP-TV-Z]{24}/g));
}
function keyed(doc: FlowDocument, key: string): FlowNode {
  return [...buildModel(doc).nodes.values()].find((n) => n.node.key === key)?.node as FlowNode;
}
function copy(text: string, keys: string[]): string {
  const doc = parse(text) as FlowDocument;
  return copyNodes(
    doc,
    keys.map((k) => keyed(doc, k).id),
  );
}
function paste(
  text: string,
  clip: string,
  extra: Partial<Extract<FlowCommand, { kind: 'pasteNodes' }>> = {},
) {
  const r = planCommand(
    text,
    { kind: 'pasteNodes', text: clip, ...extra },
    { newId: createIdFactory() },
  );
  const after = parse(r.text) as FlowDocument;
  const model = buildModel(after);
  const pasted = (r.pasted ?? []).map((id) => model.nodes.get(id)?.node as FlowNode);
  return { r, after, pasted };
}
const errors = (doc: FlowDocument) =>
  validateFlow(doc).findings.filter((f) => f.severity === 'error');

describe('copy', () => {
  it('one level: the nodes, the wires between them, their layout and open-on-purpose decisions', () => {
    const doc = parse(EDGE) as FlowDocument;
    const text = copy(EDGE, ['rollback', 'backup-config', 'push-baseline']);
    expect(text.startsWith(`${CLIP_HEADER}\n`)).toBe(true);
    const clip = parseClip(text) as Clip;
    // Document order, whatever the selection order.
    expect(clip.nodes.map((n) => n.key)).toEqual(['backup-config', 'push-baseline', 'rollback']);
    const picked = new Set(clip.nodes.map((n) => n.id));
    const inside = doc.edges.filter((e) => picked.has(e.from.node) && picked.has(e.to.node));
    expect(clip.edges).toEqual(inside);
    expect(Object.keys(clip.layout).sort()).toEqual([...picked].sort());
    expect(clip.decisions.map((d) => d.node)).toEqual([keyed(doc, 'backup-config').id]);
    expect(looksLikeNodes(text)).toBe(true);
  });

  it('auto-laid-out nodes carry the positions the canvas shows', () => {
    const doc = parse(OS) as FlowDocument;
    const ids = [keyed(doc, 'backup-config').id, keyed(doc, 'drain-traffic').id];
    const shown = { [ids[0] as string]: { x: 10, y: 20 }, [ids[1] as string]: { x: 10, y: 140 } };
    const clip = parseClip(copyNodes(doc, ids, shown)) as Clip;
    expect(clip.layout).toEqual(shown);
  });

  it('a subflow carries its inner level', () => {
    const clip = parseClip(copy(OS, ['upgrade-os'])) as Clip;
    expect(clip.nodes).toHaveLength(1);
    expect(clip.nodes[0]?.subflow?.nodes?.map((n) => n.key)).toContain('verify-checksum');
  });

  it('plain text, a mapping without nodes or an empty list is not nodes', () => {
    for (const t of ['hello', 'a: [1', 'flow: {}', '[]', '- 1\n- 2'])
      expect(typeof parseClip(t), t).toBe('string');
  });
});

describe('paste', () => {
  it('same flow: new IDs and keys, references between the copies follow, one edit', () => {
    const before = ids(EDGE);
    const { r, after, pasted } = paste(
      EDGE,
      copy(EDGE, ['backup-config', 'push-baseline', 'rollback']),
      {
        position: { x: 900, y: 500 },
      },
    );
    expect(applyEdits(EDGE, r.edits)).toBe(r.text);
    expect(r.created).toBe(r.pasted?.[0]);
    // Every old ID stays; the new ones are the nodes and the two wires between them.
    for (const id of before) expect(ids(r.text).has(id), id).toBe(true);
    expect([...ids(r.text)].filter((id) => !before.has(id))).toHaveLength(3 + 2);
    expect(pasted.map((n) => n.key)).toEqual(['backup-config-2', 'push-baseline-2', 'rollback-2']);
    expect(pasted.map((n) => n.title)).toEqual(['Backup config', 'Push baseline', 'Rollback']);
    // References to a copied node follow its new key; others stay as written.
    const [bk, push, rb] = pasted as [FlowNode, FlowNode, FlowNode];
    expect(push.inputs?.backup_ref?.from).toBe('backup-config-2.backup_ref');
    expect(rb.inputs?.backup_ref?.from).toBe('backup-config-2.backup_ref');
    expect(bk.inputs?.devices?.from).toBe('flow.devices');
    // The wires between the copies, nothing to the rest of the flow.
    const wired = after.edges.filter(
      (e) => r.pasted?.includes(e.from.node) || r.pasted?.includes(e.to.node),
    );
    expect(wired.map((e) => [e.from.node, e.from.port, e.to.node])).toEqual([
      [bk.id, 'ok_hosts', push.id],
      [push.id, 'failed_hosts', rb.id],
    ]);
    // The group keeps its shape; its top-left corner lands at the pointer.
    const at = (n: FlowNode) => after.layout?.[n.id] as { x: number; y: number };
    expect(Math.min(...pasted.map((n) => at(n).x))).toBe(900);
    expect(Math.min(...pasted.map((n) => at(n).y))).toBe(500);
    const was = parse(EDGE) as FlowDocument;
    const old = (k: string) => was.layout?.[keyed(was, k).id] as { x: number; y: number };
    expect(at(rb).x - at(bk).x).toBe(old('rollback').x - old('backup-config').x);
    // The open-on-purpose decision travels with backup-config.
    expect(after.decisions?.filter((d) => d.node === bk.id).map((d) => d.port)).toEqual([
      'failed_hosts',
    ]);
    expect(schema(after)).toEqual([]);
    expect(errors(after)).toEqual([]);
  });

  it('another flow: keys kept, references to nodes not copied stay as written', () => {
    const { after, pasted } = paste(OS, copy(EDGE, ['validate']));
    expect(pasted.map((n) => n.key)).toEqual(['validate']);
    expect(pasted[0]?.inputs?.change_report?.from).toBe('push-baseline.change_report');
    expect(schema(after)).toEqual([]);
    // Without a position the copy sits next to where it was.
    const src = parse(EDGE) as FlowDocument;
    const was = src.layout?.[keyed(src, 'validate').id] as { x: number; y: number };
    expect(after.layout?.[pasted[0]?.id as string]).toEqual({ x: was.x + 40, y: was.y + 40 });
  });

  it('a subflow: inner nodes, wires and boundary get new IDs and still match; codegen works', () => {
    const before = parse(OS) as FlowDocument;
    const { after, pasted } = paste(OS, copy(OS, ['upgrade-os']), { position: { x: 0, y: 0 } });
    const sub = pasted[0] as FlowNode;
    expect(sub.key).toBe('upgrade-os-2');
    const inner = new Set(sub.subflow?.nodes?.map((n) => n.id));
    const old = new Set(keyed(before, 'upgrade-os').subflow?.nodes?.map((n) => n.id));
    expect(inner.size).toBe(old.size);
    for (const id of inner) expect(old.has(id)).toBe(false);
    for (const e of sub.subflow?.edges ?? []) {
      expect(inner.has(e.from.node)).toBe(true);
      expect(inner.has(e.to.node)).toBe(true);
    }
    expect(inner.has(sub.subflow?.boundary?.in as string)).toBe(true);
    for (const refs of Object.values(sub.subflow?.boundary?.outputs ?? {}))
      for (const ref of refs ?? []) expect(inner.has(ref.node)).toBe(true);
    // Inner keys stay: they are unique in their own level.
    expect(sub.subflow?.nodes?.map((n) => n.key)).toEqual(
      keyed(before, 'upgrade-os').subflow?.nodes?.map((n) => n.key),
    );
    expect(schema(after)).toEqual([]);
    expect(errors(after)).toEqual([]);
    expect(optionA.generate(after, { source: 'os-upgrade.flow.yaml' }).ok).toBe(true);
  });

  it('into a subflow level; a subflow without inner steps gets them with the entry set', () => {
    const doc = parse(OS) as FlowDocument;
    const upgrade = keyed(doc, 'upgrade-os');
    const inner = paste(OS, copy(OS, ['stage-image']), { level: upgrade.id });
    expect(inner.pasted.map((n) => n.key)).toEqual(['stage-image-2']);
    expect(keyed(inner.after, 'upgrade-os').subflow?.nodes?.at(-1)?.id).toBe(inner.pasted[0]?.id);

    const drain = keyed(doc, 'drain-traffic');
    expect(drain.subflow).toBeUndefined();
    const first = paste(OS, copy(EDGE, ['precheck', 'backup-config']), { level: drain.id });
    const body = keyed(first.after, 'drain-traffic').subflow;
    expect(body?.nodes?.map((n) => n.key)).toEqual(['precheck', 'backup-config']);
    expect(body?.boundary?.in).toBe(first.pasted[0]?.id);
    expect(body?.edges).toHaveLength(1);
    expect(schema(first.after)).toEqual([]);
  });

  it('a flow shown by auto layout keeps every node where it was (product-owner report)', () => {
    // Without `freeze` the pasted node would be the only stored position, and the host's auto
    // layout stacks every other node in a column below it.
    const shown = Object.fromEntries(
      (parse(OS) as FlowDocument).nodes.map((n, i) => [n.id, { x: (i % 3) * 260, y: i * 90 }]),
    );
    const { after, pasted } = paste(OS, copy(EDGE, ['validate']), {
      position: { x: 900, y: 40 },
      freeze: shown,
    });
    for (const [id, p] of Object.entries(shown)) expect(after.layout?.[id], id).toEqual(p);
    expect(after.layout?.[pasted[0]?.id as string]).toEqual({ x: 900, y: 40 });
  });

  it('a snippet written by hand: one node or a list; tested becomes implemented', () => {
    const one = paste(EDGE, 'key: check-ntp\ntype: task\ntitle: Check NTP\nstatus: tested\n');
    expect(one.pasted.map((n) => [n.key, n.status])).toEqual([['check-ntp', 'implemented']]);
    const list = paste(
      EDGE,
      '- type: task\n  title: Check NTP\n- type: task\n  key: precheck\n  title: Again\n',
    );
    expect(list.pasted.map((n) => n.key)).toEqual(['check-ntp', 'precheck-2']);
    expect(schema(list.after)).toEqual([]);
  });

  it('refuses text that is not nodes, and a start node alone; the text is unchanged', () => {
    const ctx = { newId: createIdFactory() };
    for (const text of ['hello', copy(EDGE, ['start'])]) {
      const run = () => planCommand(EDGE, { kind: 'pasteNodes', text }, ctx);
      expect(run).toThrow(CommandError);
      try {
        run();
      } catch (e) {
        expect((e as CommandError).code).toBe('bad-clipboard');
      }
    }
    // A start node in a bigger copy is left out.
    const { pasted } = paste(EDGE, copy(EDGE, ['start', 'precheck']));
    expect(pasted.map((n) => n.type)).toEqual(['task']);
  });
});
