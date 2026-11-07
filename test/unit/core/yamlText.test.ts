// AFD-103 (round 3: R4): the YAML box colours its lines and indents on Enter, as an editor does.
import { describe, expect, it } from 'vitest';
import { enterText, yamlTokens } from '../../../src/core/view/yamlText';

const kinds = (line: string) =>
  yamlTokens(line)
    .filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`);

describe('yamlTokens', () => {
  it('gives the line back unchanged', () => {
    for (const line of [
      'when: ansible_network_os == "ios"  # only IOS',
      '  - trust',
      "- name: 'x'",
      'loop:',
      'broken: "not closed',
      '',
    ])
      expect(
        yamlTokens(line)
          .map((t) => t.text)
          .join(''),
      ).toBe(line);
  });

  it('colours keys, strings, scalars, comments and dashes', () => {
    expect(kinds('when: ansible_network_os == "ios"  # only IOS')).toEqual([
      'key:when',
      'punct::',
      'string:"ios"',
      'comment:# only IOS',
    ]);
    expect(kinds('no_log: true')).toEqual(['key:no_log', 'punct::', 'scalar:true']);
    expect(kinds('  - dmz')).toEqual(['dash:- ']);
    expect(kinds('delay: 15')).toEqual(['key:delay', 'punct::', 'scalar:15']);
    expect(kinds('# a note')).toEqual(['comment:# a note']);
    // A URL's colon is not a key.
    expect(kinds('url: https://x.example/a')).toEqual(['key:url', 'punct::']);
  });
});

describe('enterText', () => {
  it('keeps the indent, indents after a key, continues a list', () => {
    expect(enterText('no_log: true')).toEqual({ text: '\n' });
    expect(enterText('loop:')).toEqual({ text: '\n  ' });
    expect(enterText('loop:  # zones')).toEqual({ text: '\n  ' });
    expect(enterText('  - trust')).toEqual({ text: '\n  - ' });
    expect(enterText('vars:')).toEqual({ text: '\n  ' });
    expect(enterText('  zone: dmz')).toEqual({ text: '\n  ' });
  });

  it('ends a list on an empty item, and steps into an item map', () => {
    expect(enterText('  - ')).toEqual({ text: '', clear: true });
    expect(enterText('    - ')).toEqual({ text: '  ', clear: true });
    expect(enterText('- name: x')).toEqual({ text: '\n  ' });
    expect(enterText('- env:')).toEqual({ text: '\n    ' });
  });
});
