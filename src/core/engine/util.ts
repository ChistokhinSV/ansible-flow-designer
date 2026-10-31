// Small helpers shared by the engines: a content checksum and duration parsing.

/** cyrb53: a fast 53-bit string hash (not cryptographic); detects hand edits of generated files. */
export function checksum(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

const UNIT: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400 };

/** `90`, `30s`, `15m`, `4h`, `1h30m` → seconds; undefined when the text is not a duration. */
export function durationSeconds(text: string | number | undefined): number | undefined {
  if (typeof text === 'number') return text > 0 ? Math.round(text) : undefined;
  const s = text?.trim().toLowerCase();
  if (!s) return undefined;
  if (/^[0-9]+$/.test(s)) return Number(s) || undefined;
  const parts = [...s.matchAll(/([0-9]+)\s*([smhd])/g)];
  if (parts.length === 0 || parts.map((p) => p[0]).join('') !== s.replaceAll(/\s+/g, ''))
    return undefined;
  return parts.reduce((sum, p) => sum + Number(p[1]) * (UNIT[p[2] as string] ?? 0), 0) || undefined;
}

/** `1h30m`, `15m`, `45s`: the duration format settings and the Timing lens read. */
export function duration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}` || '0s';
}

/** Ansible group names: lowercase letters, digits and underscores. */
export function groupPart(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_');
}
