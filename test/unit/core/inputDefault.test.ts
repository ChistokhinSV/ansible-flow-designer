// AFD-106 (round 3: R6, Y5): a flow input's default, typed in a box and read by the input's type.
import { describe, expect, it } from 'vitest';
import { defaultText, defaultValue } from '../../../src/core/view/inputDefault';

describe('flow input defaults', () => {
  it('reads the text by the type', () => {
    expect(defaultValue('string', ' archive-01.lab.example ')).toEqual({
      value: 'archive-01.lab.example',
    });
    expect(defaultValue('integer', '15')).toEqual({ value: 15 });
    expect(defaultValue('integer', '15s')).toEqual({ problem: 'A whole number' });
    expect(defaultValue('boolean', 'Yes')).toEqual({ value: true });
    expect(defaultValue('boolean', 'maybe')).toEqual({ problem: 'true or false' });
    expect(defaultValue('list', 'trust, untrust\ndmz')).toEqual({
      value: ['trust', 'untrust', 'dmz'],
    });
    expect(defaultValue('dict', '{site: fra1}')).toEqual({ value: { site: 'fra1' } });
    expect(defaultValue('dict', 'fra1')).toEqual({ problem: 'A map, like {site: fra1}' });
    expect(defaultValue('any', '42')).toEqual({ value: 42 });
  });

  it('an empty box clears it; a default shows as it was typed', () => {
    expect(defaultValue('string', '  ')).toEqual({});
    expect(defaultText(['trust', 'dmz'])).toBe('trust, dmz');
    expect(defaultText({ site: 'fra1' })).toBe('{"site":"fra1"}');
    expect(defaultText(undefined)).toBe('');
    expect(defaultText(false)).toBe('false');
  });
});
