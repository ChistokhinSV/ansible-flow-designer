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

/**
 * Myers O(ND) diff; returns an edit script of '=', '-' (delete from a) and '+' (insert from b).
 * AFD-162: equal leading and trailing lines are matched first, so D counts only the changed
 * middle, and each round keeps its V as a small typed window (the diagonals the backtrack reads)
 * instead of a copy of a Map. A Tidy Up of 500 nodes held about 2M Map entries before.
 */
function myers(a: string[], b: string[]): string[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const middle = middleScript(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  return [...Array<string>(head).fill('='), ...middle, ...Array<string>(tail).fill('=')];
}

function middleScript(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return Array<string>(m).fill('+');
  if (m === 0) return Array<string>(n).fill('-');
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3).fill(-1);
  v[off + 1] = 0;
  // Round d reads diagonals -(d + 1) .. d + 1 of the V left by round d - 1.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[off + k - 1] ?? -1) < (v[off + k + 1] ?? -1));
      let x = down ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  throw new Error('diff failed');
}

function backtrack(trace: Int32Array[], n: number, m: number): string[] {
  const at = (d: number, k: number) => {
    const value = (trace[d] as Int32Array)[k + d + 1];
    return value === undefined ? -1 : value;
  };
  const script: string[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const k = x - y;
    const down = k === -d || (k !== d && at(d, k - 1) < at(d, k + 1));
    const prevK = down ? k + 1 : k - 1;
    const prevX = Math.max(0, at(d, prevK));
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
