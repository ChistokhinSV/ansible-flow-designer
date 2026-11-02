// Text width without a browser (AFD-25): SVG has no ellipsis, so the writer cuts titles itself.
// Widths are Helvetica/Arial advance widths (per 1000 em) for printable ASCII; the SVG asks for
// Arial first, so the estimate holds where it is viewed. Other characters count as 0.6 em.
const ASCII =
  '278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584'
    .split(',')
    .map(Number);

/** Bold Helvetica runs about 7% wider on average. */
const BOLD = 1.07;

export function textWidth(
  text: string,
  size: number,
  opts: { bold?: boolean; mono?: boolean } = {},
): number {
  if (opts.mono) return [...text].length * size * 0.6;
  let units = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    units += c >= 32 && c <= 126 ? (ASCII[c - 32] ?? 600) : 600;
  }
  return (units / 1000) * size * (opts.bold ? BOLD : 1);
}

/** The text, cut with an ellipsis to fit `max` pixels. */
export function fitText(
  text: string,
  max: number,
  size: number,
  opts: { bold?: boolean; mono?: boolean } = {},
): string {
  if (textWidth(text, size, opts) <= max) return text;
  const chars = [...text];
  while (chars.length > 0 && textWidth(`${chars.join('')}…`, size, opts) > max) chars.pop();
  return `${chars.join('').trimEnd()}…`;
}

/** Lines of `text` wrapped at word boundaries to `max` pixels; long words are cut to fit. */
export function wrapText(text: string, max: number, size: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size) <= max || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
      if (textWidth(line, size) > max) line = fitText(line, max, size);
    }
    out.push(line);
  }
  return out;
}
