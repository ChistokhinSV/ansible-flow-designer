// AFD-64: Notes, Sections and Text in the flow document. One edit and one undo each; they are not
// design (no version bump, no tested drop-back, no shared-edited); a Note on a node follows it
// through delete, extract, copy and paste; hand-written ones are completed like nodes.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { sectionContents } from '../../../src/core/flow/annotations';
import { copyNodes } from '../../../src/core/flow/clipboard';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { completeIds, idGaps } from '../../../src/core/flow/completeIds';
import { createIdFactory } from '../../../src/core/flow/ids';
import { levelView } from '../../../src/core/flow/levelView';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { refDesign } from '../../../src/core/flow/refs';
import { planSave } from '../../../src/core/flow/save';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { semanticKey } from '../../../src/core/flow/semantic';
import type { Annotation, FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml/edits';
import { sharedSource } from '../../../src/node/sharedRefs';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const schema = createSchemaValidator();
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const doc = (text: string) => parse(text) as FlowDocument;
const BASE = run(readExample('edge-baseline.flow.yaml'), { kind: 'upgradeFormat' }).text;
const id = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key)?.node.id as string;
const notes = (text: string, level = ROOT): Annotation[] =>
  buildModel(doc(text)).levels.get(level)?.annotations ?? [];
const valid = (text: string) => {
  expect(schema(doc(text))).toEqual([]);
  expect(validateFlow(doc(text)).findings.filter((f) => f.severity === 'error')).toEqual([]);
};

describe('annotations in the document (AFD-64)', () => {
  it('a note, a note on a node, a section and text: one edit each, valid, not design', () => {
    const precheck = id(BASE, 'precheck');
    const a = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'Why we **drain** first:\n- traffic\n- alarms', x: 600, y: 40 },
    });
    expect(a.edits).toHaveLength(1);
    expect(a.text).toContain(
      '  text: |-\n    Why we **drain** first:\n    - traffic\n    - alarms',
    );
    const b = run(a.text, {
      kind: 'addAnnotation',
      annotation: { text: 'Fails safe', on: precheck, x: 232, y: 0, color: 'green' },
    });
    const c = run(b.text, {
      kind: 'addAnnotation',
      annotation: {
        kind: 'section',
        text: 'Change window',
        x: 80,
        y: 240,
        width: 500,
        height: 400,
      },
    });
    const d = run(c.text, {
      kind: 'addAnnotation',
      annotation: { kind: 'text', text: 'Edge baseline', size: 'l', x: 100, y: -60 },
    });
    expect(notes(d.text).map((n) => [n.key, n.kind, n.on])).toEqual([
      ['note-1', 'note', undefined],
      ['note-2', 'note', precheck],
      ['section-1', 'section', undefined],
      ['text-1', 'text', undefined],
    ]);
    expect(notes(d.text)[0]?.text).toBe('Why we **drain** first:\n- traffic\n- alarms');
    valid(d.text);
    // Not design: the same semantic key, no version bump on save.
    expect(semanticKey(doc(d.text))).toBe(semanticKey(doc(BASE)));
    expect(planSave(d.text, BASE, BASE).edits).toEqual([]);
    // A module param named annotations is design (stripped where annotations live, not by name).
    const k8s = structuredClone(doc(BASE));
    (k8s.nodes[1] as FlowNode).impl = {
      kind: 'module',
      ref: 'kubernetes.core.k8s',
      params: { definition: { metadata: { annotations: { team: 'netops' } } } },
    };
    const k8sOther = structuredClone(k8s);
    (k8sOther.nodes[1] as FlowNode).impl = {
      kind: 'module',
      ref: 'kubernetes.core.k8s',
      params: { definition: { metadata: { annotations: { team: 'edge' } } } },
    };
    expect(semanticKey(k8sOther)).not.toBe(semanticKey(k8s));
  });

  it('the tied note is drawn next to its node and follows it', () => {
    const precheck = id(BASE, 'precheck');
    const t = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'n', on: precheck, x: 232, y: 4 },
    }).text;
    const snap = { doc: doc(t), openPorts: openFailPorts(buildModel(doc(t))), autoPositions: {} };
    const view = levelView(snap as never);
    const at = doc(t).layout?.[precheck];
    expect(view.annotations[0]?.position).toEqual({ x: (at?.x ?? 0) + 232, y: (at?.y ?? 0) + 4 });
    const moved = levelView(snap as never, { [precheck]: { x: 0, y: 0 } });
    expect(moved.annotations[0]?.position).toEqual({ x: 232, y: 4 });
  });

  it('update: text as a literal block, look, untie keeps the place, retie', () => {
    const precheck = id(BASE, 'precheck');
    const at = doc(BASE).layout?.[precheck] ?? { x: 0, y: 0 };
    const t = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'one', on: precheck, x: 232, y: 0 },
    }).text;
    const note = notes(t)[0] as Annotation;
    const r = run(t, {
      kind: 'updateAnnotation',
      id: note.id,
      patch: { text: 'line 1\nline 2\n', color: 'pink' },
    });
    expect(r.edits.length).toBeGreaterThan(0);
    expect(notes(r.text)[0]).toMatchObject({ text: 'line 1\nline 2\n', color: 'pink' });
    expect(r.text).toContain('text: |\n');
    const free = run(r.text, { kind: 'updateAnnotation', id: note.id, patch: { on: null } }).text;
    expect(notes(free)[0]).toMatchObject({ x: at.x + 232, y: at.y });
    expect(notes(free)[0]?.on).toBeUndefined();
    const again = run(free, {
      kind: 'updateAnnotation',
      id: note.id,
      patch: { on: precheck },
    }).text;
    expect(notes(again)[0]).toMatchObject({ on: precheck, x: 232, y: 0 });
    expect(() =>
      run(again, { kind: 'updateAnnotation', id: note.id, patch: { size: 'l' } }),
    ).toThrow(CommandError);
    valid(again);
  });

  it('move and delete: a frame drag is one edit; a node takes its notes; the last one takes the key', () => {
    const precheck = id(BASE, 'precheck');
    const one = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'on precheck', on: precheck, x: 232, y: 0 },
    }).text;
    const two = run(one, {
      kind: 'addAnnotation',
      annotation: { kind: 'section', text: 'All', x: 0, y: 0, width: 2000, height: 2000 },
    }).text;
    const [tied, section] = notes(two) as [Annotation, Annotation];
    const moved = run(two, {
      kind: 'moveNodes',
      positions: { [precheck]: { x: 10, y: 20 } },
      annotations: { [section.id]: { x: 5, y: 6 } },
    });
    expect(applyEdits(two, moved.edits)).toBe(moved.text);
    expect(notes(moved.text)[1]).toMatchObject({ x: 5, y: 6 });
    // Deleting the node removes the note on it; deleting the rest removes the key.
    const gone = run(two, { kind: 'deleteNodes', ids: [precheck] }).text;
    expect(notes(gone).map((n) => n.id)).toEqual([section.id]);
    const none = run(gone, { kind: 'deleteNodes', ids: [], annotations: [section.id] }).text;
    expect(none).not.toContain('annotations:');
    expect(doc(none).annotations).toBeUndefined();
    expect(tied.id).not.toBe(section.id);
    valid(none);
  });

  it('extract into a subflow takes the notes on the nodes and the annotations picked', () => {
    const backup = id(BASE, 'backup-config');
    const push = id(BASE, 'push-baseline');
    let t = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'on backup', on: backup, x: 232, y: 0 },
    }).text;
    t = run(t, { kind: 'addAnnotation', annotation: { text: 'loose', x: 900, y: 900 } }).text;
    t = run(t, { kind: 'addAnnotation', annotation: { text: 'stays', x: 900, y: 50 } }).text;
    const loose = notes(t)[1] as Annotation;
    const r = run(t, {
      kind: 'extractSubflow',
      nodes: [backup, push],
      title: 'Change',
      annotations: [loose.id],
    });
    const sub = r.created as string;
    expect(notes(r.text, sub).map((n) => n.text)).toEqual(['on backup', 'loose']);
    expect(notes(r.text).map((n) => n.text)).toEqual(['stays']);
    valid(r.text);
  });

  it('copy and paste: notes come with their nodes, new IDs and keys, tied to the copies', () => {
    const precheck = id(BASE, 'precheck');
    let t = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'on precheck', on: precheck, x: 232, y: 0 },
    }).text;
    t = run(t, { kind: 'addAnnotation', annotation: { text: 'picked', x: 700, y: 100 } }).text;
    const picked = notes(t)[1] as Annotation;
    const clip = copyNodes(doc(t), [precheck], {}, [picked.id]);
    expect(clip).toContain('annotations:');
    const r = run(t, { kind: 'pasteNodes', text: clip, position: { x: 1000, y: 1000 } });
    const copy = r.pasted?.[0] as string;
    const after = notes(r.text);
    expect(after).toHaveLength(4);
    const pasted = after.slice(2);
    expect(pasted.find((n) => n.text === 'on precheck')?.on).toBe(copy);
    expect(new Set(after.map((n) => n.id)).size).toBe(4);
    expect(new Set(after.map((n) => n.key)).size).toBe(4);
    valid(r.text);
    // A clip of annotations only pastes too.
    const only = copyNodes(doc(t), [], {}, [picked.id]);
    expect(notes(run(t, { kind: 'pasteNodes', text: only }).text)).toHaveLength(3);
  });

  it('shared copies carry the source level’s annotations; they are not an edit of the copy', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afd64-'));
    try {
      mkdirSync(join(dir, 'src'));
      const os = run(readExample('os-upgrade.flow.yaml'), { kind: 'upgradeFormat' }).text;
      const inner = id(os, 'upgrade-os');
      const withNote = run(os, {
        kind: 'addAnnotation',
        level: inner,
        annotation: { text: 'Stage first', x: 0, y: 0 },
      }).text;
      writeFileSync(join(dir, 'src', 'os.flow.yaml'), withNote);
      const src = sharedSource(join(dir, 'x.flow.yaml'), 'src/os.flow.yaml#upgrade-os');
      const r = run(BASE, {
        kind: 'addReference',
        from: 'src/os.flow.yaml#upgrade-os',
        version: 1,
        source: src.node as FlowNode,
      });
      const copy = doc(r.text).nodes.find((n) => n.key === 'upgrade-os') as FlowNode;
      expect(copy.subflow?.annotations?.[0]?.text).toBe('Stage first');
      expect(copy.subflow?.annotations?.[0]?.id).not.toBe(
        (src.node as FlowNode).subflow?.annotations?.[0]?.id,
      );
      expect(refDesign(copy)).toBe(copy.ref?.design);
      expect(validateFlow(doc(r.text)).findings.map((f) => f.code)).not.toContain('shared-edited');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('written by hand: Complete IDs fills id and key and resolves the node key', () => {
    const text = `${BASE}annotations:\n- on: precheck\n  x: 232\n  y: 0\n  text: by hand\n`;
    expect(idGaps(doc(text)).map((g) => g.kind)).toContain('annotation');
    const done = completeIds(text, createIdFactory());
    const n = notes(done.text)[0] as Annotation;
    expect(n.key).toBe('note-1');
    expect(n.on).toBe(id(BASE, 'precheck'));
    expect(done.filled.annotations).toBe(2);
    expect(idGaps(doc(done.text))).toEqual([]);
    valid(done.text);
  });

  it('checks: a note on a node of another level, sections inside, format 1', () => {
    const t = `${BASE}annotations:\n- id: 01JBZZZZZZZZZZZZZZZZZZZZZZ\n  key: note-1\n  on: 01JBZZZZZZZZZZZZZZZZZZZZZY\n  x: 0\n  y: 0\n  text: lost\n`;
    expect(validateFlow(doc(t)).findings.map((f) => f.code)).toContain('annotation-target-missing');
    expect(() =>
      run(readExample('edge-baseline.flow.yaml'), {
        kind: 'addAnnotation',
        annotation: { text: 'x', x: 0, y: 0 },
      }),
    ).toThrow(/format 2/);
    const precheck = id(BASE, 'precheck');
    const withSection = run(BASE, {
      kind: 'addAnnotation',
      annotation: { kind: 'section', text: 'All', x: -5000, y: -5000, width: 20000, height: 20000 },
    }).text;
    const snap = {
      doc: doc(withSection),
      openPorts: openFailPorts(buildModel(doc(withSection))),
      autoPositions: {},
    };
    const view = levelView(snap as never);
    const inside = sectionContents(view, notes(withSection)[0]?.id as string);
    expect(inside.nodes).toContain(precheck);
  });

  it('one undo: applying the edits backwards restores the bytes', () => {
    const r = run(BASE, {
      kind: 'addAnnotation',
      annotation: { text: 'a\nb', x: 1, y: 2 },
    });
    expect(applyEdits(BASE, r.edits)).toBe(r.text);
  });
});
