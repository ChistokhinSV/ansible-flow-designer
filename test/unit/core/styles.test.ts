// AFD-36: the stylesheet split by area, with font sizes from the type scale only.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIR = join(__dirname, '../../../src/webview/styles');
const files = readdirSync(DIR).filter((f) => f.endsWith('.css') && f !== 'index.css');

describe('webview styles', () => {
  it('index.css imports every area file once, in name order (the cascade order)', () => {
    const index = readFileSync(join(DIR, 'index.css'), 'utf8');
    const imported = [...index.matchAll(/@import ["']\.\/([^"']+)["'];/g)].map((m) => m[1]);
    expect(imported).toEqual([...files].sort());
  });

  it('sets pixel font sizes only through the type scale tokens', () => {
    const literal = files.flatMap((f) =>
      [...readFileSync(join(DIR, f), 'utf8').matchAll(/font-size:\s*[0-9.]+px/g)].map(
        (m) => `${f}: ${m[0]}`,
      ),
    );
    expect(literal).toEqual([]);
    const base = readFileSync(join(DIR, '00-base.css'), 'utf8');
    expect(base).toContain('--afd-font-node-title:');
    expect(base).toContain('--afd-right-width: 320px;');
  });
});
