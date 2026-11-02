// AFD-65: a Note's tie runs border to border on the line between the centres, never under a box.
import { describe, expect, it } from 'vitest';
import { tieLine } from '../../../src/core/view/tie';

describe('tie of a note to its node (AFD-65)', () => {
  it('leaves the note and reaches the node at their borders', () => {
    const note = { x: 300, y: 0, width: 200, height: 76 };
    const node = { x: 0, y: 0, width: 208, height: 76 };
    expect(tieLine(note, node)).toEqual({ from: { x: 300, y: 38 }, to: { x: 208, y: 38 } });
    const below = tieLine({ x: 0, y: 200, width: 208, height: 100 }, node);
    expect(below).toEqual({ from: { x: 104, y: 200 }, to: { x: 104, y: 76 } });
  });

  it('draws nothing when the boxes overlap', () => {
    expect(
      tieLine({ x: 100, y: 10, width: 200, height: 76 }, { x: 0, y: 0, width: 208, height: 76 }),
    ).toBeUndefined();
  });
});
