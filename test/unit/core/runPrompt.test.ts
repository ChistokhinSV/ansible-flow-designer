// AFD-71: a first skeleton run suggests localhost for its hosts; nothing else is guessed.
import { describe, expect, it } from 'vitest';
import { inputPrompt, inputSuggestion } from '../../../src/core/run/prompt';

describe('run input suggestions (AFD-71)', () => {
  const hosts = { type: 'host_list' as const };
  it.each([
    ['remembered wins', hosts, ['edge-1'], true, ['edge-1']],
    ['then the default', { ...hosts, default: ['lab'] }, undefined, true, ['lab']],
    ['a skeleton run starts on localhost', hosts, undefined, true, ['localhost']],
    ['a real run guesses no hosts', hosts, undefined, false, undefined],
    ['nor any other input', { type: 'string' as const }, undefined, true, undefined],
  ])('%s', (_, field, remembered, check, want) => {
    expect(inputSuggestion(field, remembered, check)).toEqual(want);
  });

  it('says what localhost does on a skeleton run', () => {
    expect(inputPrompt('host_list', false, true)).toMatch(/localhost runs the skeleton/);
    expect(inputPrompt('host_list', false, false)).toBe('Hosts or groups, comma-separated');
    expect(inputPrompt('string', true, false)).toBe('string (not remembered)');
  });
});

describe('input descriptions in the prompts (AFD-95)', () => {
  it("an input's description leads its prompt", () => {
    expect(inputPrompt('list', false, true, 'The log collectors to point at')).toBe(
      'The log collectors to point at (list)',
    );
    expect(inputPrompt('string', true, false, 'The enable secret')).toBe(
      'The enable secret (string, not remembered)',
    );
  });
});
