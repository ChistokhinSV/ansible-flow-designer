// Text edits as UTF-16 offsets (the unit of JS strings and of VS Code's offsetAt/positionAt).

export interface TextEdit {
  start: number;
  end: number;
  newText: string;
}

/** Applies non-overlapping edits computed against the same text. Inserts at one offset keep their order. */
export function applyEdits(text: string, edits: readonly TextEdit[]): string {
  const ordered = edits
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.start - a.e.start || b.e.end - a.e.end || b.i - a.i);
  let out = text;
  let floor = Number.POSITIVE_INFINITY;
  for (const { e } of ordered) {
    if (e.end > floor) throw new Error(`overlapping edits at ${e.start}..${e.end}`);
    out = out.slice(0, e.start) + e.newText + out.slice(e.end);
    floor = e.start;
  }
  return out;
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      lines.push(text.slice(start, i + 1));
      start = i + 1;
    }
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/**
 * Minimal edits turning `before` into `after`: a line-level Myers diff, then each hunk trimmed to
 * its changed characters. Commands compose several YAML ops sequentially and report the result
 * through this, so every command is one small WorkspaceEdit regardless of how it was built.
 */
export function diffEdits(before: string, after: string): TextEdit[] {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  const script = myers(a, b);
  const offsets = [0];
  for (const line of a) offsets.push((offsets.at(-1) ?? 0) + line.length);

  const edits: TextEdit[] = [];
  let i = 0;
  let j = 0;
  let k = 0;
  while (k < script.length) {
    if (script[k] === '=') {
      i++;
      j++;
      k++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while (k < script.length && script[k] !== '=') {
      if (script[k] === '-') i++;
      else j++;
      k++;
    }
    const oldText = a.slice(i0, i).join('');
    const newText = b.slice(j0, j).join('');
    edits.push(trimEdit(offsets[i0] ?? 0, oldText, newText));
  }
  return edits;
}

function trimEdit(start: number, oldText: string, newText: string): TextEdit {
  let p = 0;
  const max = Math.min(oldText.length, newText.length);
  while (p < max && oldText.charCodeAt(p) === newText.charCodeAt(p)) p++;
  let s = 0;
  while (
    s < max - p &&
    oldText.charCodeAt(oldText.length - 1 - s) === newText.charCodeAt(newText.length - 1 - s)
  ) {
    s++;
  }
  return {
    start: start + p,
    end: start + oldText.length - s,
    newText: newText.slice(p, newText.length - s),
  };
}

/** Myers O(ND) diff; returns an edit script of '=', '-' (delete from a) and '+' (insert from b). */
function myers(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>([[1, 0]]);
  const trace: Map<number, number>[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(new Map(v));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
      let x = down ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v.set(k, x);
      if (x >= n && y >= m) return backtrack(trace, a.length, b.length);
    }
  }
  throw new Error('diff failed');
}

function backtrack(trace: Map<number, number>[], n: number, m: number): string[] {
  const script: string[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d] as Map<number, number>;
    const k = x - y;
    const down = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = v.get(prevK) ?? 0;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      script.push('=');
      x--;
      y--;
    }
    if (d > 0) script.push(down ? '+' : '-');
    x = prevX;
    y = prevY;
  }
  return script.reverse();
}
