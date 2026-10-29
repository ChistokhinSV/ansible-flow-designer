// `collections/requirements.yml` pins and ansible-galaxy version specs (`>=1.2.0,<2.0.0`, `==1.4.1`,
// `!=3.0.0`, `*`, a bare version), so the Code lens can tell an EE that does not meet them offline.
import { parse } from 'yaml';

export function parseRequirements(text: string): Record<string, string> {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return {};
  }
  const list = (data as { collections?: unknown })?.collections;
  const out: Record<string, string> = {};
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (typeof item === 'string') out[item] = '*';
    else if (item && typeof item === 'object') {
      const { name, version } = item as { name?: unknown; version?: unknown };
      // `name` may be a source (a URL or a tarball); only collection names are compared.
      if (typeof name === 'string' && /^[a-z0-9_]+\.[a-z0-9_]+$/i.test(name))
        out[name] = version === undefined || version === null ? '*' : String(version);
    }
  }
  return out;
}

function parts(version: string): { nums: number[]; pre: boolean } {
  const [core = '', pre] = version.trim().split(/[-+]/, 2);
  return { nums: core.split('.').map((n) => Number.parseInt(n, 10) || 0), pre: pre !== undefined };
}

export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length, 3); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d !== 0) return d;
  }
  // A pre-release sorts before its release.
  return Number(y.pre) - Number(x.pre);
}

/** Whether an installed version meets a galaxy version spec. */
export function satisfies(version: string, spec: string): boolean {
  for (const raw of spec.split(',')) {
    const clause = raw.trim();
    if (!clause || clause === '*') continue;
    const m = /^(==|!=|>=|<=|>|<)?\s*(.+)$/.exec(clause);
    if (!m) return false;
    const c = compareVersions(version, m[2] as string);
    const ok =
      m[1] === '!='
        ? c !== 0
        : m[1] === '>='
          ? c >= 0
          : m[1] === '<='
            ? c <= 0
            : m[1] === '>'
              ? c > 0
              : m[1] === '<'
                ? c < 0
                : c === 0;
    if (!ok) return false;
  }
  return true;
}
