// AFD-83: a lens says what it shows, and why it shows nothing on this level (round 1: P10).
import { describe, expect, it } from 'vitest';
import { lensCaption } from '../../../src/core/lens/caption';
import type { LensView } from '../../../src/core/lens/types';

const view = (chips: LensView['chips'], notes: string[] = []): LensView => ({
  lens: 'data',
  chips,
  stats: [],
  sections: [],
  findings: [],
  notes,
});
const level = [
  { id: 'S', type: 'start' },
  { id: 'A', type: 'task' },
  { id: 'B', type: 'task' },
  { id: 'E', type: 'end' },
];

describe('lensCaption', () => {
  it('says what the lens shows; nothing more while a step has something for it', () => {
    const c = lensCaption('data', view({ A: [{ text: 'in: x' }] }), level, 'lab');
    expect(c.what).toMatch(/reads and sets/);
    expect(c.empty).toBeUndefined();
  });

  it('a level where no step has a chip says why, per lens', () => {
    expect(lensCaption('data', view({}), level, 'lab').empty).toBe(
      'No step on this level reads an input or sets an output.',
    );
    expect(lensCaption('code', view({ S: [{ text: 'x' }] }), level, 'lab').empty).toMatch(
      /bound to a module/,
    );
    // The lens's own note (no inventory read, no runs) explains it better.
    expect(lensCaption('timing', view({}, ['No run timed yet.']), level, 'lab').empty).toBe(
      'No run timed yet.',
    );
  });

  it('the Inventory lens without flow targets asks for them', () => {
    const c = lensCaption('inventory', view({ S: [{ text: 'devices: not set' }] }), level, '');
    expect(c).toMatchObject({ setTargets: true });
    expect(c.empty).toMatch(/targets are not set/);
  });

  it('a level with no steps has nothing to explain', () => {
    expect(
      lensCaption('data', view({}), [level[0] as { id: string; type: string }], 'lab').empty,
    ).toBeUndefined();
  });
});
