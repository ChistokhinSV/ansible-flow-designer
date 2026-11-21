// AFD-354: the Changes lens of a past version says what it compares with, counts note changes,
// names a step's place once, and leaves wires between added steps unlabelled.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { modelOf } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { lensCaption, lensWhat } from '../../../src/core/lens/caption';
import { changesLens } from '../../../src/core/lens/changes';

const BASE = readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8');
const doc = (t: string) => parse(t) as FlowDocument;
const ctx = { newId: createIdFactory() };
const apply = (t: string, ...cmds: FlowCommand[]) =>
  cmds.reduce((text, c) => planCommand(text, c, ctx).text, t);
const ready = (base: FlowDocument, label: string) => ({
  state: 'ready' as const,
  ref: 'r',
  label,
  refs: [{ ref: 'r', label }],
  base,
});
const topLevel = (d: FlowDocument) =>
  (modelOf(d).levels.get('root')?.nodes ?? []).map((n) => ({ id: n.id, type: n.type }));

describe('the Changes lens of a past version (AFD-354)', () => {
  it('counts the notes that changed instead of saying nothing changed', () => {
    const now = doc(
      apply(
        BASE,
        { kind: 'addAnnotation', annotation: { text: 'One', x: 900, y: 0 } },
        { kind: 'addAnnotation', annotation: { text: 'Two', x: 900, y: 200 } },
      ),
    );
    const view = changesLens(now, ready(doc(BASE), 'the version before abc'));
    expect(view.annotationWords).toBe('2 notes added');
    const c = lensCaption('changes', view, topLevel(now), 'lab', ready(doc(BASE), 'x'));
    expect(c.empty).toBeUndefined();
    expect(c.also).toBe('No step on this level changed; 2 notes added.');
  });

  it('names the one version it compares with; several versions keep the general words', () => {
    expect(lensWhat('changes', { label: 'the version before abc', refs: [] })).toBe(
      'What changed since the version before abc',
    );
    expect(
      lensWhat('changes', {
        label: 'HEAD',
        refs: [
          { ref: 'HEAD', label: 'HEAD' },
          { ref: 'main', label: 'main' },
        ],
      }),
    ).toMatch(/HEAD, a branch or a commit/);
  });

  it('a flow the commit added: steps say added, wires between them have no label', () => {
    const now = doc(BASE);
    const nothing = { ...now, nodes: [], edges: [], annotations: [] };
    const view = changesLens(now, ready(nothing, 'nothing'));
    const added = view.sections.find((s) => s.title === 'Added')?.items ?? [];
    expect(added.length).toBeGreaterThan(0);
    // The panel names a step's place itself; the row does not say it again.
    expect(added.every((i) => i.detail === undefined)).toBe(true);
    expect(view.wires).toEqual({});
  });
});
