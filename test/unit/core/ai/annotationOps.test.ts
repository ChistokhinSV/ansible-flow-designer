// AFD-64: agents write Notes, Sections and Text by key path: annotate, update_annotation, and the
// delete and move ops. Nothing they say holds an ID; a section carries what is inside it; nothing
// of it is design.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { describeFlow } from '../../../../src/core/ai/describe';
import { applyOps, type Op } from '../../../../src/core/ai/ops';
import { checkOps } from '../../../../src/core/ai/specs';
import { planCommand } from '../../../../src/core/flow/commands';
import { createIdFactory } from '../../../../src/core/flow/ids';
import { buildModel } from '../../../../src/core/flow/model';
import { semanticKey } from '../../../../src/core/flow/semantic';
import type { FlowDocument } from '../../../../src/core/flow/types';
import { layoutLevel, shownPositions } from '../../../../src/node/autoLayout';
import { readExample } from '../helpers';

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const newId = createIdFactory();
const ctx = { newId, layout: layoutLevel, positions: shownPositions };
const BASE = planCommand(
  readExample('edge-baseline.flow.yaml'),
  { kind: 'upgradeFormat' },
  {
    newId,
  },
).text;
const doc = (t: string) => parse(t) as FlowDocument;
const run = (text: string, ops: Op[]) => {
  expect(checkOps(ops)).toEqual([]);
  return applyOps(text, ops, ctx);
};

describe('annotation ops (AFD-64)', () => {
  it('annotate a node, a section around steps and a heading; describe lists them by key', async () => {
    const r = await run(BASE, [
      {
        op: 'annotate',
        on: 'precheck',
        text: 'Read-only: **safe** to rerun\nhttps://wiki.example.net/edge',
      },
      {
        op: 'annotate',
        kind: 'section',
        text: 'Change',
        position: { x: 60, y: 240 },
        width: 600,
        height: 400,
      },
      {
        op: 'annotate',
        kind: 'text',
        text: 'Edge baseline',
        size: 'l',
        position: { above: 'precheck' },
      },
    ]);
    const anns = doc(r.text).annotations ?? [];
    expect(anns.map((a) => [a.key, a.kind])).toEqual([
      ['note-1', 'note'],
      ['section-1', 'section'],
      ['text-1', 'text'],
    ]);
    const precheck = buildModel(doc(r.text)).levels.get('root')?.nodes[1];
    expect(anns[0]?.on).toBe(precheck?.id);
    expect(semanticKey(doc(r.text))).toBe(semanticKey(doc(BASE)));
    const text = describeFlow(buildModel(doc(r.text)), [], 'r1');
    expect(text).toContain('  annotations:');
    expect(text).toContain('note-1 (note on precheck): "Read-only: safe to rerun" (+1 line(s))');
    expect(text).toContain('section-1 (section): "Change"');
    expect(text).not.toMatch(ULID);
  });

  it('update, move a section with its steps, untie, delete', async () => {
    const one = await run(BASE, [
      { op: 'annotate', on: 'precheck', text: 'n' },
      {
        op: 'annotate',
        kind: 'section',
        text: 'All',
        position: { x: -2000, y: -2000 },
        width: 6000,
        height: 6000,
      },
    ]);
    const before = doc(one.text);
    const precheckId = before.nodes[1]?.id as string;
    const at = before.layout?.[precheckId] as { x: number; y: number };
    const two = await run(one.text, [
      { op: 'update_annotation', annotation: 'note-1', color: 'green', text: 'checked' },
      { op: 'move', annotations: { 'section-1': { x: -1900, y: -2000 } } },
    ]);
    const after = doc(two.text);
    expect(after.layout?.[precheckId]).toEqual({ x: at.x + 100, y: at.y });
    expect(after.annotations?.[0]).toMatchObject({ color: 'green', text: 'checked' });
    const three = await run(two.text, [
      { op: 'update_annotation', annotation: 'note-1', on: null },
      { op: 'delete', annotations: ['section-1'] },
    ]);
    const last = doc(three.text);
    expect(last.annotations?.map((a) => a.key)).toEqual(['note-1']);
    expect(last.annotations?.[0]?.on).toBeUndefined();
    expect(last.annotations?.[0]?.x).toBe((after.layout?.[precheckId]?.x ?? 0) + 232);
  });

  it('a section around nodes holds them and the notes on them, and a move carries them (AFD-217)', async () => {
    const r = await run(BASE, [
      { op: 'annotate', on: 'backup-config', text: 'Kept 30 days' },
      { op: 'annotate', text: 'Change', around: ['backup-config', 'push-baseline'] },
    ]);
    const d = doc(r.text);
    const section = d.annotations?.find((a) => a.kind === 'section');
    expect(section).toMatchObject({ key: 'section-1', text: 'Change' });
    const s = section as { x: number; y: number; width: number; height: number };
    const idOf = (key: string) => d.nodes.find((n) => n.key === key)?.id as string;
    const inside = (x: number, y: number, w: number, h: number) =>
      x >= s.x && y >= s.y && x + w <= s.x + s.width && y + h <= s.y + s.height;
    const backup = d.layout?.[idOf('backup-config')] as { x: number; y: number };
    const push = d.layout?.[idOf('push-baseline')] as { x: number; y: number };
    expect(inside(backup.x, backup.y, 208, 76)).toBe(true);
    expect(inside(push.x, push.y, 208, 76)).toBe(true);
    const note = d.annotations?.find((a) => a.kind === 'note') as { x: number; y: number };
    expect(inside(backup.x + note.x, backup.y + note.y, 200, 120)).toBe(true);
    // The level was auto-placed: drawing the section stored every node where it was shown.
    expect(Object.keys(d.layout ?? {})).toHaveLength(d.nodes.length);
    expect(semanticKey(d)).toBe(semanticKey(doc(BASE)));

    const moved = doc(
      (await run(r.text, [{ op: 'move', annotations: { 'section-1': { x: s.x + 40, y: s.y } } }]))
        .text,
    );
    expect(moved.layout?.[idOf('push-baseline')]).toEqual({ x: push.x + 40, y: push.y });
    expect(moved.layout?.[idOf('precheck')]).toEqual(d.layout?.[idOf('precheck')]);
  });

  it('around refuses a place, another kind and nodes of two levels', async () => {
    await expect(
      run(BASE, [{ op: 'annotate', text: 'x', around: ['precheck'], position: { x: 0, y: 0 } }]),
    ).rejects.toThrow(/leave out position/);
    await expect(
      run(BASE, [{ op: 'annotate', kind: 'note', text: 'x', around: ['precheck'] }]),
    ).rejects.toThrow(/around draws a section/);
    await expect(
      run(BASE, [
        { op: 'extract_subflow', nodes: ['backup-config', 'push-baseline'], title: 'Change' },
        { op: 'annotate', text: 'x', around: ['change/backup-config', 'validate'] },
      ]),
    ).rejects.toThrow(/a section goes around nodes of one level/);
  });

  it('errors name annotations by key, never by ID', async () => {
    await expect(
      run(BASE, [{ op: 'update_annotation', annotation: 'note-9', text: 'x' }]),
    ).rejects.toThrow(/No annotation "note-9"/);
    await expect(
      run(BASE, [{ op: 'annotate', kind: 'section', on: 'precheck', text: 'x' }]),
    ).rejects.toThrow(/Only a note can be on a node/);
  });
});
