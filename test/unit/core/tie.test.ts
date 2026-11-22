// AFD-65: a Note's tie runs border to border on the line between the centres, never under a box.
// AFD-350: given the step's ports, it keeps clear of them and of their wires' stubs.
import { describe, expect, it } from 'vitest';
import { type TiePort, tieLine } from '../../../src/core/view/tie';

const node = { x: 0, y: 0, width: 208, height: 76 };

/** Whether the tie comes within `by` px of the point. */
function near(
  tie: { from: { x: number; y: number }; to: { x: number; y: number } },
  p: { x: number; y: number },
  by: number,
) {
  for (let i = 0; i <= 50; i++) {
    const k = i / 50;
    const x = tie.from.x + (tie.to.x - tie.from.x) * k;
    const y = tie.from.y + (tie.to.y - tie.from.y) * k;
    if (Math.hypot(x - p.x, y - p.y) < by) return true;
  }
  return false;
}

describe('tie of a note to its node (AFD-65)', () => {
  it('leaves the note and reaches the node at their borders', () => {
    const note = { x: 300, y: 0, width: 200, height: 76 };
    expect(tieLine(note, node)).toEqual({ from: { x: 300, y: 38 }, to: { x: 208, y: 38 } });
    const below = tieLine({ x: 0, y: 200, width: 208, height: 100 }, node);
    expect(below).toEqual({ from: { x: 104, y: 200 }, to: { x: 104, y: 76 } });
  });

  it('draws nothing when the boxes overlap', () => {
    expect(tieLine({ x: 100, y: 10, width: 200, height: 76 }, node)).toBeUndefined();
  });
});

describe('a tie clear of the ports (AFD-350)', () => {
  const ports: TiePort[] = [
    { side: 'top', offset: 0.5 },
    { side: 'bottom', offset: 0.5 },
    { side: 'right', offset: 0.3 },
    { side: 'right', offset: 0.7 },
  ];

  it('a note below no longer meets the ok port and its wire', () => {
    const tie = tieLine({ x: 0, y: 200, width: 208, height: 100 }, node, ports);
    expect(tie).toBeDefined();
    if (!tie) return;
    expect(tie.to.y).toBe(76);
    expect(near(tie, { x: 104, y: 76 }, 12)).toBe(false);
    expect(near(tie, { x: 104, y: 106 }, 12)).toBe(false);
  });

  it('a note beside keeps off the fail ports and their stubs', () => {
    const tie = tieLine({ x: 320, y: 0, width: 200, height: 76 }, node, ports);
    expect(tie).toBeDefined();
    if (!tie) return;
    for (const y of [76 * 0.3, 76 * 0.7]) {
      expect(near(tie, { x: 208, y }, 12)).toBe(false);
      expect(near(tie, { x: 238, y }, 12)).toBe(false);
    }
  });

  it('keeps the straight tie when nothing is in its way', () => {
    const note = { x: 300, y: 0, width: 200, height: 76 };
    expect(tieLine(note, node, [{ side: 'bottom', offset: 0.5 }])).toEqual(tieLine(note, node));
  });
});

describe('a tie clear of the ports shown on hover (AFD-351)', () => {
  // A task's right side: failed_hosts wired (at rest), unreachable and timeout on hover.
  const ports: TiePort[] = [
    { side: 'right', offset: 0.25 },
    { side: 'right', offset: 0.5, optional: true },
    { side: 'right', offset: 0.75, optional: true },
  ];

  it('a Note on the right does not leave between unreachable and timeout', () => {
    const tie = tieLine({ x: 318, y: 0, width: 200, height: 120 }, node, ports);
    if (!tie) throw new Error('no tie');
    expect(tie.to.y < 38 || tie.to.y > 57).toBe(true);
    expect(near(tie, { x: 208, y: 19 }, 12)).toBe(false);
    // Nor across their labels, past the ports.
    expect(near(tie, { x: 260, y: 38 }, 6)).toBe(false);
    expect(near(tie, { x: 260, y: 57 }, 6)).toBe(false);
  });

  it('a Note on the left keeps its straight tie', () => {
    const note = { x: -232, y: 0, width: 200, height: 76 };
    expect(tieLine(note, node, ports)).toEqual(tieLine(note, node));
  });
});
