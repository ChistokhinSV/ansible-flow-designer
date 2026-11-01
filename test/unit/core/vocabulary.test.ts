// AFD-41: one word per thing. The glossary's "Not" column lists the words we do not use; no label,
// message, command title or guide page may use them, and no milestone or decision codes reach
// what users read. Comments do not count: Biome puts every comment on its own line or after the
// code, so comment lines and trailing ` // ` comments are left out (TypeScript 7 has no parser API).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '../../..');
const GLOSSARY = join(ROOT, 'docs/guide/reference/glossary.md');

function files(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

/** The backticked words in the last column of the glossary's tables. */
function bannedWords(): string[] {
  return readFileSync(GLOSSARY, 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('|') && !/^\|\s*-/.test(line))
    .flatMap((line) => {
      const cells = line.split('|').slice(1, -1);
      return [...(cells.at(-1) ?? '').matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
    });
}

/** The code lines of a source file (strings, JSX text, identifiers), without comments. */
function uiStrings(path: string): { text: string; line: number }[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((text, i) => ({ text: text.replace(/\s\/\/\s.*$/, ''), line: i + 1 }))
    .filter(({ text }) => !/^\s*(\/\/|\/\*|\*|\{\/\*)/.test(text));
}

const SOURCES = ['src/webview', 'src/core', 'src/extension'].flatMap((d) =>
  files(join(ROOT, d), /\.tsx?$/),
);
const PAGES = [
  ...files(join(ROOT, 'docs/guide'), /\.md$/).filter((p) => p !== GLOSSARY),
  ...files(join(ROOT, 'media/walkthrough'), /\.md$/),
  join(ROOT, 'README.md'),
];
const CODES = [/\(M\d+\)/, /\bdecision \d+\b/i];

/**
 * The word on its own: not inside an identifier (`setResyncAfter`) or a longer word (`Add steps`);
 * Markdown's `_italics_` around it still count.
 */
function wordRule(word: string): RegExp {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9-])${escaped}(?![A-Za-z0-9])`);
}

describe('vocabulary (AFD-41)', () => {
  const banned = bannedWords().map((word) => ({ word, rule: wordRule(word) }));

  it('the glossary lists the words we do not use', () => {
    const words = banned.map((b) => b.word);
    expect(words).toContain('Open as text');
    expect(words).toContain('Implementation mode');
    expect(words.length).toBeGreaterThan(20);
  });

  it('labels, messages and command titles use the glossary words, without milestone codes', () => {
    const found: string[] = [];
    for (const path of SOURCES)
      for (const { text, line } of uiStrings(path)) {
        for (const { word, rule } of banned)
          if (rule.test(text)) found.push(`${relative(ROOT, path)}:${line} "${word}"`);
        for (const code of CODES)
          if (code.test(text)) found.push(`${relative(ROOT, path)}:${line} ${code}`);
      }
    const pkg = readFileSync(join(ROOT, 'package.json'), 'utf8');
    for (const { word, rule } of banned) if (rule.test(pkg)) found.push(`package.json "${word}"`);
    for (const code of CODES) if (code.test(pkg)) found.push(`package.json ${code}`);
    expect(found.join('\n')).toBe('');
  });

  it('keybindings run our commands, only while the designer has focus', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    const ours = new Set(pkg.contributes.commands.map((c: { command: string }) => c.command));
    for (const k of pkg.contributes.keybindings as { command: string; when: string }[]) {
      expect(ours.has(k.command), k.command).toBe(true);
      expect(k.when).toMatch(/^activeCustomEditorId == afd\.flowEditor($| )/);
    }
  });

  it('the guide and the walkthrough use the glossary words', () => {
    const found: string[] = [];
    for (const path of PAGES) {
      const text = readFileSync(path, 'utf8');
      for (const { word, rule } of banned)
        if (rule.test(text)) found.push(`${relative(ROOT, path)} "${word}"`);
    }
    expect(found.join('\n')).toBe('');
  });
});
