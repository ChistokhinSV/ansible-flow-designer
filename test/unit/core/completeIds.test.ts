// AFD-19: a flow written by hand (no IDs, nodes named by key) is checked as usual, shown with its
// gaps filled, and completed in one byte-preserving edit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { parseClip } from '../../../src/core/flow/clipboard';
import { completeIds, idGaps, withIds } from '../../../src/core/flow/completeIds';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits, diffEdits } from '../../../src/core/yaml';

const read = (p: string) => readFileSync(join(__dirname, '../../..', p), 'utf8');
const HAND = read('test/fixtures/flows/hand-written.flow.yaml');
const EDGE = read('examples/edge-baseline.flow.yaml');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const schema = createSchemaValidator();

describe('a flow written by hand', () => {
  it('is valid against the schema and lists what it lacks', () => {
    const doc = parse(HAND) as FlowDocument;
    expect(schema(doc)).toEqual([]);
    const gaps = idGaps(doc);
    expect(gaps.map((g) => g.kind).sort()).toEqual(
      [
        'flow',
        ...Array(5).fill('node'),
        ...Array(2).fill('node'),
        ...Array(5).fill('wire'),
        'ref',
        'ref',
        'ref',
        'layout',
        'layout',
      ].sort(),
    );
    for (const g of gaps) expect(g.message).not.toMatch(ULID);
    expect(idGaps(parse(EDGE) as FlowDocument)).toEqual([]);
  });

  it('is checked as usual: gaps are errors, the rest of the design is checked on the filled copy', () => {
    const { findings, model } = validateFlow(parse(HAND) as FlowDocument);
    const codes = findings.map((f) => f.code);
    expect(codes.filter((c) => c === 'missing-id')).toHaveLength(idGaps(parse(HAND)).length);
    expect(codes).not.toContain('edge-missing-node');
    expect(codes).not.toContain('layout-orphan');
    expect(codes).not.toContain('duplicate-key');
    // The open-on-purpose decision named by key still silences the open port of check-ntp.
    const open = findings.filter((f) => f.code === 'open-fail-port').map((f) => f.message);
    expect(open.some((m) => m.includes('Check NTP'))).toBe(false);
    // The canvas gets the same IDs on every parse, so nothing jumps while the text changes.
    expect(withIds(parse(HAND) as FlowDocument)).toEqual(model.doc);
    expect([...buildModel(model.doc).nodes.values()]).toHaveLength(7);
  });

  it('Complete IDs: one edit, only IDs added and keys replaced; valid; a second run changes nothing', () => {
    const r = completeIds(HAND, createIdFactory());
    expect(r.filled).toEqual({ nodes: 7, wires: 5, refs: 15 });
    expect(r.unresolved).toEqual([]);
    const doc = parse(r.text) as FlowDocument;
    expect(idGaps(doc)).toEqual([]);
    expect(schema(doc)).toEqual([]);
    expect(validateFlow(doc).findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Every changed line carries an ID; comments and everything else stay byte for byte.
    for (const e of diffEdits(HAND, r.text)) expect(e.newText).toMatch(ULID);
    expect(r.text.startsWith('# Written by hand')).toBe(true);
    expect(completeIds(r.text, createIdFactory()).text).toBe(r.text);
    // Layout keyed by key moved to the IDs.
    const start = doc.nodes.find((n) => n.key === 'start')?.id as string;
    expect(doc.layout?.[start]).toEqual({ x: 100, y: 40 });
  });

  it('keeps CRLF line ends', () => {
    const crlf = HAND.replace(/\n/g, '\r\n');
    const r = completeIds(crlf, createIdFactory());
    expect(r.text.includes('\r\n')).toBe(true);
    expect(r.text.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });

  it('an unknown key is reported, not guessed; the rest is completed', () => {
    const text = HAND.replace('to: {node: done, port: in}', 'to: {node: finished, port: in}');
    const findings = validateFlow(parse(text) as FlowDocument).findings;
    expect(findings.some((f) => f.code === 'unknown-key' && f.message.includes('"finished"'))).toBe(
      true,
    );
    const r = completeIds(text, createIdFactory());
    expect(r.unresolved.map((g) => g.message)).toEqual([
      'No node with key "finished" (wire to on the top level)',
    ]);
    expect(r.text).toContain('node: finished');
    expect(applyEdits(text, diffEdits(text, r.text))).toBe(r.text);
  });

  it('wires written as flow mappings: IDs go into the text, the spacing stays', () => {
    // An `id:` added to a flow mapping used to re-render it whole, over the edits of its node keys.
    const text = [
      '# Wires by key, written as flow mappings',
      'schema_version: 1',
      'flow:',
      '  key: wires',
      '  name: Wires',
      '  version: 1',
      'nodes:',
      '- {key: start, type: start, title: Start}',
      '- key: work',
      '  type: task',
      '  title: Work',
      '- key: done',
      '  type: end',
      '  title: Done',
      '  outcome: success',
      'edges:',
      '  # spaced',
      '  - { from: { node: start, port: ok_hosts }, to: { node: work, port: in } }',
      '  # compact',
      '  - {from: {node: work, port: ok_hosts}, to: {node: done, port: in}}',
      '  # block wire, flow-style ends',
      '  - from: { node: work, port: failed_hosts }',
      '    to: {node: done, port: in}',
      '',
    ].join('\n');
    let n = 0;
    const r = completeIds(text, () => `01J${String(++n).padStart(23, '0')}`);
    const id = (i: number) => `01J${String(i).padStart(23, '0')}`;
    // Minted in order: the flow, the nodes, the wires.
    const [F, START, WORK, DONE, W1, W2, W3] = [1, 2, 3, 4, 5, 6, 7].map(id);
    expect(r.text).toBe(
      text
        .replace('flow:\n', `flow:\n  id: ${F}\n`)
        .replace('{key: start,', `{id: ${START}, key: start,`)
        .replace('- key: work', `- id: ${WORK}\n  key: work`)
        .replace('- key: done', `- id: ${DONE}\n  key: done`)
        .replace(
          '  - { from: { node: start, port: ok_hosts }, to: { node: work, port: in } }',
          `  - { id: ${W1}, from: { node: ${START}, port: ok_hosts }, to: { node: ${WORK}, port: in } }`,
        )
        .replace(
          '  - {from: {node: work, port: ok_hosts}, to: {node: done, port: in}}',
          `  - {id: ${W2}, from: {node: ${WORK}, port: ok_hosts}, to: {node: ${DONE}, port: in}}`,
        )
        .replace(
          '  - from: { node: work, port: failed_hosts }\n    to: {node: done, port: in}',
          `  - id: ${W3}\n    from: { node: ${WORK}, port: failed_hosts }\n    to: {node: ${DONE}, port: in}`,
        ),
    );
    expect(r.filled).toEqual({ nodes: 3, wires: 3, refs: 6 });
    const doc = parse(r.text) as FlowDocument;
    expect(idGaps(doc)).toEqual([]);
    expect(schema(doc)).toEqual([]);
    expect(doc.edges.map((e) => [e.id, e.from.node, e.to.node])).toEqual([
      [W1, START, WORK],
      [W2, WORK, DONE],
      [W3, WORK, DONE],
    ]);
    expect(completeIds(r.text, createIdFactory()).text).toBe(r.text);
  });

  it('a snippet written by hand pastes with its wires', () => {
    const clip = parseClip(
      'nodes:\n- {key: a, type: task, title: A}\n- {key: b, type: task, title: B}\nedges:\n- from: {node: a, port: ok_hosts}\n  to: {node: b, port: in}\n',
    );
    if (typeof clip === 'string') throw new Error(clip);
    const [a, b] = clip.nodes;
    expect(clip.edges).toEqual([
      expect.objectContaining({
        from: { node: a?.id, port: 'ok_hosts' },
        to: { node: b?.id, port: 'in' },
      }),
    ]);
  });
});
