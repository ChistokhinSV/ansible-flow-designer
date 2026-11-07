// Durations as the flow writes them (settings.timeout, an approval's timeout): `90`, `30s`, `15m`,
// `4h`, `1h30m`. In core/flow so the validator can check them without an engine (AFD-40); the
// engines read them through core/engine/util.

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

/** `8 min 30 s`, `1 h 5 min`, `45 s`: a length of time in a sentence (AFD-111). */
export function spokenDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const parts = [h ? `${h} h` : '', m ? `${m} min` : '', s ? `${s} s` : ''].filter(Boolean);
  return parts.join(' ') || '0 s';
}
