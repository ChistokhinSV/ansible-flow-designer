// AFD-66: the Changes lens lists annotations added, changed and removed (a move is no change),
// and outlines the added and changed ones on the canvas.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { diffFlows } from '../../../src/core/flow/semanticDiff';
import type { FlowDocument } from '../../../src/core/flow/types';
import { changesLens } from '../../../src/core/lens/changes';

const BASE = readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8');
const doc = (t: string) => parse(t) as FlowDocument;
const id = (key: string) => doc(BASE).annotations?.find((a) => a.key === key)?.id as string;
const ctx = { newId: createIdFactory() };
const apply = (t: string, ...cmds: FlowCommand[]) =>
  cmds.reduce((text, c) => planCommand(text, c, ctx).text, t);

describe('annotations in the Changes lens (AFD-66)', () => {
  it('added, changed and removed; moved is not changed', () => {
    const now = apply(
      BASE,
      { kind: 'addAnnotation', annotation: { text: 'New: check the AAA servers', x: 900, y: 0 } },
      {
        kind: 'updateAnnotation',
        id: id('note-1'),
        patch: { text: 'Read-only; rerun at will', color: 'blue' },
      },
      { kind: 'moveNodes', positions: {}, annotations: { [id('text-1')]: { x: 0, y: -100 } } },
      { kind: 'deleteNodes', ids: [], annotations: [id('note-3')] },
    );
    const diff = diffFlows(doc(BASE), doc(now));
    expect(diff.nodes).toEqual([]);
    expect(diff.annotations.map((a) => [a.kind, a.key, a.fields.map((f) => f.field)])).toEqual([
      ['changed', 'note-1', ['text', 'color']],
      ['added', 'note-4', []],
      ['removed', 'note-3', []],
    ]);
    const view = changesLens(doc(now), {
      state: 'ready',
      ref: 'HEAD',
      label: 'HEAD (main)',
      refs: [],
      base: doc(BASE),
    });
    expect(view.annotations).toEqual({
      [id('note-1')]: 'changed',
      [diff.annotations[1]?.id as string]: 'added',
    });
    expect(view.stats).toContainEqual({ label: 'Annotations', value: '+1 ~1 −1' });
    const section = view.sections.find((s) => s.title === 'Annotations');
    expect(section?.items.map((i) => i.label)).toEqual([
      '~ note note-1: Read-only; rerun at will',
      '+ note note-4: New: check the AAA servers',
      '− note note-3: Runbook: https://wiki.example.net/edge-baseline',
    ]);
    expect(
      changesLens(doc(BASE), {
        state: 'ready',
        ref: 'HEAD',
        label: 'HEAD',
        refs: [],
        base: doc(BASE),
      }).notes,
    ).toEqual(['No changes since HEAD']);
  });
});
