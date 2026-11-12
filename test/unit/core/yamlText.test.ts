// AFD-103 (round 3: R4): the YAML box colours its lines and indents on Enter, as an editor does.
import { describe, expect, it } from 'vitest';
import {
  enterText,
  yamlColours,
  yamlKeyContext,
  yamlTokens,
} from '../../../src/core/view/yamlText';

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

  it("reads '' and \\\" inside quoted strings as part of them (AFD-222)", () => {
    expect(kinds("ts: '{{ now().strftime(''%Y'') }}'  # stamp")).toEqual([
      'key:ts',
      'punct::',
      "string:'{{ now().strftime(''%Y'') }}'",
      'comment:# stamp',
    ]);
    expect(kinds('msg: "say \\"hi\\"" # q')).toEqual([
      'key:msg',
      'punct::',
      'string:"say \\"hi\\""',
      'comment:# q',
    ]);
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

describe('yamlColours (AFD-224)', () => {
  const colours = (line: string, bare = false) =>
    yamlColours(line, bare)
      .filter((p) => p.colour)
      .map((p) => `${p.colour}:${p.text}`);

  it('gives the line back, and colours Jinja inside a quoted value', () => {
    const line = "ts: '{{ now(utc=true).strftime(''%Y'') }}'  # stamp";
    expect(
      yamlColours(line)
        .map((p) => p.text)
        .join(''),
    ).toBe(line);
    expect(colours(line)).toEqual([
      'key:ts',
      'muted::',
      "string:'",
      'delim:{{',
      'func:now',
      'var:utc',
      'constant:true',
      'func:strftime',
      "string:''",
      'format:%Y',
      "string:''",
      'delim:}}',
      "string:'",
      'comment:# stamp',
    ]);
  });

  it('colours a bare value as an expression, and plain text around a template', () => {
    expect(colours('when: result.rc == 0', true)).toEqual([
      'key:when',
      'muted::',
      'var:result',
      'var:rc',
      'number:0',
    ]);
    expect(colours('path: /tmp/{{ name }}.txt')).toEqual([
      'key:path',
      'muted::',
      'delim:{{',
      'var:name',
      'delim:}}',
    ]);
    expect(colours('retries: 3')).toEqual(['key:retries', 'muted::', 'number:3']);
    expect(colours('no_log: true')).toEqual(['key:no_log', 'muted::', 'constant:true']);
  });

  it('knows which top-level key each line belongs to', () => {
    expect(
      yamlKeyContext(['when:', '  - a == 1', '  - b', 'loop: "{{ x }}"', 'vars:', '  y: 1']),
    ).toEqual(['when', 'when', 'when', 'loop', 'vars', 'vars']);
  });
});
