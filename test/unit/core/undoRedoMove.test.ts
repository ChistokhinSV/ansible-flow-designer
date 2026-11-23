// AFS-203: in Ansible Flow Server's pages, a move after Undo failed with "overlapping edits at …"
// for every node. The server's Undo and Redo merge the flow (mergeFlows(after, current, before))
// and write it back (writeMergedFlow); the next move is planned on that text (planCommand). Undoing
// the first move or Tidy Up left `layout: {}`, and a move of several nodes added each position to
// that empty map in its own edit: the edits overlapped.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { mergeFlows } from '../../../src/core/flow/merge';
import { writeMergedFlow } from '../../../src/core/flow/mergeText';
import type { FlowDocument } from '../../../src/core/flow/types';

const doc = (text: string) => parseFlow(text).doc as FlowDocument;
const sample = (name: string) => readFileSync(join('samples', `${name}.flow.yaml`), 'utf8');
type Positions = Record<string, { x: number; y: number }>;
const plan = (text: string, kind: 'moveNodes' | 'tidyUp', positions: Positions) =>
  planCommand(text, { kind, positions } as FlowCommand, { newId: () => 'X' }).text;
/** The server's undo (or redo) of an edit that turned `before` into `after`, on `current`. */
const back = (after: string, current: string, before: string) => {
  const merged = mergeFlows(doc(after), doc(current), doc(before));
  expect(merged.conflicts).toEqual([]);
  return writeMergedFlow(current, merged.doc);
};

describe('moves after undo and redo (AFS-203)', () => {
  it('undoing the first Tidy Up leaves no layout, and the next one writes several positions', () => {
    const t0 = sample('hello');
    const [a, b, c] = doc(t0).nodes.map((n) => n.id) as [string, string, string];
    const tidied = plan(t0, 'tidyUp', { [a]: { x: 10, y: 20 }, [b]: { x: 30, y: 40 } });
    const undone = back(tidied, tidied, t0);
    expect(doc(undone).layout).toBeUndefined();
    expect(undone).toBe(t0);
    const again = plan(undone, 'tidyUp', {
      [a]: { x: 1, y: 2 },
      [b]: { x: 3, y: 4 },
      [c]: { x: 5, y: 6 },
    });
    expect(doc(again).layout).toEqual({
      [a]: { x: 1, y: 2 },
      [b]: { x: 3, y: 4 },
      [c]: { x: 5, y: 6 },
    });
  });

  it('a move of several nodes into an empty layout map is one edit', () => {
    const t0 = sample('hello');
    const [a, b] = doc(t0).nodes.map((n) => n.id) as [string, string];
    const empty = t0.replace(/\nnodes:/, '\nlayout: {}\nnodes:');
    expect(doc(empty).layout).toEqual({});
    const moved = plan(empty, 'moveNodes', { [a]: { x: 7, y: 8 }, [b]: { x: 9, y: 10 } });
    expect(doc(moved).layout).toEqual({ [a]: { x: 7, y: 8 }, [b]: { x: 9, y: 10 } });
  });

  it('a move undone and redone comes back, and the next move works', () => {
    const t0 = sample('firewall-upgrade');
    const [a, b] = doc(t0).nodes.map((n) => n.id) as [string, string];
    const t1 = plan(t0, 'moveNodes', { [a]: { x: 100, y: 200 } });
    const undone = back(t1, t1, t0);
    const redone = back(undone, undone, t1);
    expect(doc(redone).layout?.[a]).toEqual({ x: 100, y: 200 });
    const t3 = plan(redone, 'moveNodes', { [a]: { x: 140, y: 260 }, [b]: { x: 300, y: 90 } });
    expect(doc(t3).layout).toMatchObject({ [a]: { x: 140, y: 260 }, [b]: { x: 300, y: 90 } });
  });

  // Random moves, Tidy Ups, undos and redos as the server's drafts do them (a new edit ends redo).
  function session(text0: string, seed: number, steps = 30): string {
    let s = seed;
    const r = () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    const ids = doc(text0).nodes.map((n) => n.id);
    const log: {
      kind: 'edit' | 'undo' | 'redo';
      before: string;
      after: string;
      undone: boolean;
    }[] = [];
    let text = text0;
    const replay = (e: (typeof log)[number], kind: 'undo' | 'redo') => {
      const merged = mergeFlows(doc(e.after), doc(text), doc(e.before));
      if (merged.conflicts.length) return;
      const after = writeMergedFlow(text, merged.doc);
      log.push({ kind, before: text, after, undone: false });
      e.undone = true;
      text = after;
    };
    for (let i = 0; i < steps; i++) {
      const p = r();
      if (p < 0.5) {
        const positions: Positions = {};
        for (let k = 0, n = 1 + Math.floor(r() * 3); k < n; k++)
          positions[ids[Math.floor(r() * ids.length)] as string] = {
            x: Math.round(r() * 900),
            y: Math.round(r() * 900),
          };
        const after = plan(text, r() < 0.2 ? 'tidyUp' : 'moveNodes', positions);
        for (const e of log) if (e.kind === 'undo') e.undone = true;
        log.push({ kind: 'edit', before: text, after, undone: false });
        text = after;
      } else if (p < 0.75) {
        const last = [...log].reverse().find((e) => !e.undone && e.kind !== 'undo');
        if (last) replay(last, 'undo');
      } else {
        const last = [...log].reverse().find((e) => !e.undone && e.kind === 'undo');
        if (last) replay(last, 'redo');
      }
    }
    return text;
  }
  for (const name of ['hello', 'edge-baseline', 'firewall-upgrade'])
    it(`${name}: random moves, Tidy Ups, undos and redos never break the next move`, () => {
      for (let seed = 1; seed <= 10; seed++)
        expect(() => parseFlow(session(sample(name), seed))).not.toThrow();
    }, 60_000);
});
