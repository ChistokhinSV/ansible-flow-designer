// AFD-243 (experimental): a subflow expanded in place: its frame, the steps drawn inside it, and
// how far the steps around it are pushed on screen.
import { describe, expect, it } from 'vitest';
import type { LevelView, NodeView } from '../../../src/core/flow/levelView';
import type { FlowNode } from '../../../src/core/flow/types';
import { expandLevel } from '../../../src/core/view/expandView';

const box = (id: string, x: number, y: number, type: FlowNode['type'] = 'task'): NodeView => ({
  node: { id, key: id, type, title: id } as FlowNode,
  position: { x, y },
  width: 208,
  height: 76,
  ports: [],
  openFail: 0,
});
const level: LevelView = {
  nodes: [box('a', 0, 0), box('sub', 0, 120, 'subflow'), box('b', 0, 240), box('side', 400, 120)],
  edges: [],
  annotations: [],
};
const inside: LevelView = {
  nodes: [box('s1', 1000, 500), box('s2', 1300, 620)],
  edges: [
    {
      id: 'w',
      source: 's1',
      sourcePort: 'ok_hosts',
      target: 's2',
      targetPort: 'in',
      tone: 'ok',
      problem: false,
    },
  ],
  annotations: [],
};
const at = (v: LevelView, id: string) => v.nodes.find((n) => n.node.id === id) as NodeView;

describe('expand a subflow in place (AFD-243)', () => {
  it('nothing expanded: the level as it is', () => {
    const out = expandLevel(level, () => inside, []);
    expect(out.view).toBe(level);
    expect(out.frames.size).toBe(0);
  });

  it('the subflow grows about its middle and holds its steps and wires', () => {
    const out = expandLevel(level, () => inside, ['sub']);
    const frame = at(out.view, 'sub');
    // Inner steps span 508 x 196: the frame adds a margin and room for its title.
    expect([frame.width, frame.height]).toEqual([564, 268]);
    expect(frame.position).toEqual({ x: -178, y: 120 });
    expect(out.frames.has('sub')).toBe(true);
    expect(out.inner).toEqual({ s1: 'sub', s2: 'sub' });
    const s1 = at(out.view, 's1');
    const s2 = at(out.view, 's2');
    // Inside the frame, their arrangement kept.
    expect(s1.position).toEqual({ x: -150, y: 164 });
    expect([s2.position.x - s1.position.x, s2.position.y - s1.position.y]).toEqual([300, 120]);
    expect(s2.position.x + s2.width).toBeLessThanOrEqual(frame.position.x + frame.width);
    expect(s2.position.y + s2.height).toBeLessThanOrEqual(frame.position.y + frame.height);
    expect(out.view.edges).toEqual([{ ...inside.edges[0], inner: true }]);
  });

  it('pushes what is under it down and what is beside it aside, on screen only', () => {
    const out = expandLevel(level, () => inside, ['sub']);
    expect(at(out.view, 'a').position).toEqual({ x: 0, y: 0 });
    expect(at(out.view, 'b').position).toEqual({ x: 0, y: 240 + 192 });
    expect(at(out.view, 'side').position).toEqual({ x: 400 + 178, y: 120 });
    expect(out.shift).toEqual({
      b: { x: 0, y: 192 },
      side: { x: 178, y: 0 },
      sub: { x: -178, y: 0 },
    });
    // The level given is not changed.
    expect(at(level, 'b').position).toEqual({ x: 0, y: 240 });
  });

  it('a subflow without steps stays a node', () => {
    const empty = { nodes: [], edges: [], annotations: [] };
    const out = expandLevel(level, () => empty, ['sub']);
    expect(out.frames.size).toBe(0);
    expect(out.view).toBe(level);
  });
});
