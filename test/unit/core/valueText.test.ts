// AFD-286: a one-line value read as YAML reads it, and shown back so it reads the same again.
import { describe, expect, it } from 'vitest';
import { textOfValue, valueOfText } from '../../../src/core/flow/valueText';

describe('valueOfText / textOfValue (AFD-286)', () => {
  it('unquoted [..] and {..} are a list and a map; quoted, the text inside', () => {
    expect(valueOfText('[mc, python3]')).toEqual(['mc', 'python3']);
    expect(valueOfText('{a: 1, b: [x]}')).toEqual({ a: 1, b: ['x'] });
    expect(valueOfText('"[mc, python3]"')).toBe('[mc, python3]');
    expect(valueOfText("'{a: 1}'")).toBe('{a: 1}');
  });

  it('templates, half-typed brackets and plain words stay the text typed', () => {
    for (const t of ['{{ pkgs }}', '{% if x %}y{% endif %}', '[mc', 'hello', '5', '"plain"'])
      expect(valueOfText(t)).toBe(t);
  });

  it('shows a value so it reads back the same', () => {
    for (const v of [
      ['mc', 'python3'],
      { a: 1, b: ['x'] },
      '[mc, python3]',
      '{a: 1}',
      '{{ pkgs }}',
      '[mc',
      'hello',
      '"plain"',
      '"[x]"',
    ])
      expect(valueOfText(textOfValue(v) as string)).toEqual(v);
    expect(textOfValue(['mc', 'python3'])).toBe('[mc, python3]');
    expect(textOfValue('[mc, python3]')).toBe('"[mc, python3]"');
    expect(textOfValue('[mc')).toBe('[mc');
  });
});
