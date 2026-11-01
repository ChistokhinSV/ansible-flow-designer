// AFD-60: a subflow copied from another flow, pinned to that flow's version: Add copies it with new
// IDs and its key, Update brings a newer version, Unlink makes it this flow's own, and an edit
// here is named.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { refDesign, sharedAround, subflowsOf } from '../../../src/core/flow/refs';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const schema = createSchemaValidator();
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const doc = (text: string) => parse(text) as FlowDocument;
// The source: os-upgrade's Upgrade OS subflow; the target: edge-baseline in format 2.
const SOURCE = doc(readExample('os-upgrade.flow.yaml'));
const upgradeOs = subflowsOf(SOURCE).find((s) => s.path === 'upgrade-os')?.node as FlowNode;
const TARGET = run(readExample('edge-baseline.flow.yaml'), { kind: 'upgradeFormat' }).text;
const FROM = '../os-upgrade/os-upgrade.flow.yaml#upgrade-os';
const node = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key)?.node as FlowNode;

describe('shared subflows (AFD-60)', () => {
  it('lists the subflows a flow offers, by key path', () => {
    expect(subflowsOf(SOURCE).map((s) => s.path)).toEqual(['upgrade-os']);
  });

  it('Add copies the subflow with new IDs and its key, pinned to the version; the code generates', () => {
    const r = run(TARGET, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs });
    const copy = node(r.text, 'upgrade-os');
    expect(copy.ref).toEqual({ from: FROM, version: 3, design: refDesign(copy) });
    expect(copy.subflow?.nodes?.map((n) => n.key)).toEqual(
      upgradeOs.subflow?.nodes?.map((n) => n.key),
    );
    const sourceIds = new Set(upgradeOs.subflow?.nodes?.map((n) => n.id));
    expect(copy.subflow?.nodes?.some((n) => sourceIds.has(n.id))).toBe(false);
    expect(copy.subflow?.boundary?.in).toBe(copy.subflow?.nodes?.[0]?.id);
    expect(schema(doc(r.text))).toEqual([]);
    expect(validateFlow(doc(r.text)).findings.map((f) => f.code)).not.toContain('shared-edited');
    expect(optionA.generate(doc(r.text), { source: 'x' }).ok).toBe(true);
    // Its level is read-only in the designer: the copy is edited in its source.
    expect(sharedAround(doc(r.text), copy.id)?.key).toBe('upgrade-os');
  });

  it('an edit here is named; Update brings the source back; Unlink keeps the edit', () => {
    const added = run(TARGET, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs });
    const copy = node(added.text, 'upgrade-os');
    const inner = copy.subflow?.nodes?.[0] as FlowNode;
    const edited = run(added.text, {
      kind: 'updateNode',
      id: inner.id,
      patch: { title: 'Stage the image (local)' },
    }).text;
    const warning = validateFlow(doc(edited)).findings.find((f) => f.code === 'shared-edited');
    expect(warning?.message).toContain(`since version 3 of ${FROM}`);
    // A newer source: Update copies it again and pins version 4.
    const newer = structuredClone(upgradeOs);
    newer.intent = 'Upgrade, now with a checksum report';
    const updated = run(edited, {
      kind: 'updateReference',
      id: copy.id,
      version: 4,
      source: newer,
    }).text;
    const after = node(updated, 'upgrade-os');
    expect(after.ref?.version).toBe(4);
    expect(after.intent).toBe('Upgrade, now with a checksum report');
    expect(after.subflow?.nodes?.[0]?.title).toBe(upgradeOs.subflow?.nodes?.[0]?.title);
    expect(validateFlow(doc(updated)).findings.map((f) => f.code)).not.toContain('shared-edited');
    // Unlink: the edits stay, the warning and the reference go.
    const unlinked = run(edited, { kind: 'unlinkReference', id: copy.id }).text;
    expect(node(unlinked, 'upgrade-os').ref).toBeUndefined();
    expect(validateFlow(doc(unlinked)).findings.map((f) => f.code)).not.toContain('shared-edited');
  });

  it('needs format 2 and a free key', () => {
    const v1 = readExample('edge-baseline.flow.yaml');
    expect(() =>
      run(v1, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs }),
    ).toThrow(/format 2|Upgrade Flow Format/);
    const once = run(TARGET, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs });
    expect(() =>
      run(once.text, { kind: 'addReference', from: FROM, version: 3, source: upgradeOs }),
    ).toThrow(CommandError);
  });
});
