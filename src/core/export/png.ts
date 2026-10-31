// draw.io diagram inside a PNG (AFD-25), as draw.io writes `.drawio.png`: a zTXt chunk with the
// keyword `mxGraphModel` holding the raw-deflated, URI-encoded file (checked against draw.io 27).
// The deflate comes from the caller (Node's zlib on the host), so this stays free of Node APIs.

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

let table: Uint32Array | undefined;

export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (const b of bytes) c = (table[(c ^ b) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const latin1 = (s: string) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);

function isPng(png: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => png[i] === b);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** The PNG with the draw.io file embedded right after the header chunk (any old one dropped). */
export function embedDiagramInPng(
  png: Uint8Array,
  xml: string,
  deflateRaw: (data: Uint8Array) => Uint8Array,
): Uint8Array {
  if (!isPng(png)) throw new Error('not a PNG image');
  const keyword = latin1('mxGraphModel');
  const packed = deflateRaw(latin1(encodeURIComponent(xml)));
  const data = new Uint8Array(keyword.length + 2 + packed.length);
  data.set(keyword, 0);
  // Null separator, then compression method 0.
  data.set(packed, keyword.length + 2);
  const parts: Uint8Array[] = [png.subarray(0, 8)];
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const whole = png.subarray(at, at + 12 + len);
    const own =
      type === 'zTXt' && String.fromCharCode(...png.subarray(at + 8, at + 20)) === 'mxGraphModel';
    if (!own) parts.push(whole);
    if (type === 'IHDR') parts.push(chunk('zTXt', data));
    at += 12 + len;
  }
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** The draw.io file embedded in a PNG, if any (for tests and round trips). */
export function diagramInPng(
  png: Uint8Array,
  inflateRaw: (data: Uint8Array) => Uint8Array,
): string | undefined {
  if (!isPng(png)) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  while (at + 12 <= png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === 'zTXt') {
      const data = png.subarray(at + 8, at + 8 + len);
      const sep = data.indexOf(0);
      if (String.fromCharCode(...data.subarray(0, sep)) === 'mxGraphModel') {
        // URI-encoded, so plain ASCII; decoded in slices to stay clear of argument limits.
        const bytes = inflateRaw(data.subarray(sep + 2));
        let s = '';
        for (let i = 0; i < bytes.length; i += 8192)
          s += String.fromCharCode(...bytes.subarray(i, i + 8192));
        return decodeURIComponent(s);
      }
    }
    at += 12 + len;
  }
  return undefined;
}
