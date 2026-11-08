// AFD-165: the host checks what a designer webview sends before acting on it. The webview runs
// under a strict CSP with no HTML sinks, so a compromised page is unlikely; these checks keep one
// from turning a message into a git option, a file outside the workspace or a probe argument.
// Shape only: what a value means (a known ref, a path inside the folder) is checked where it is
// used.

const isMap = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

const str = (v: unknown, max = 4096): v is string => typeof v === 'string' && v.length <= max;
const optNum = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
const strList = (v: unknown) =>
  v === undefined || (Array.isArray(v) && v.every((x) => str(x, 200)));

/** A plugin name the probe looks up: dotted words, no option or path syntax. */
export const PLUGIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.]{0,199}$/;

/** A git revision a designer may ask to compare with: never an option (`-…`), no spaces. */
export const GIT_REF = /^[A-Za-z0-9_][A-Za-z0-9_./@{}^~-]{0,199}$/;

const CATALOG_OPS = new Set(['search', 'doc', 'roles', 'playbooks', 'rebuild']);

function catalogProblem(r: unknown): string | undefined {
  if (!isMap(r) || !CATALOG_OPS.has(String(r.op))) return 'catalog: unknown request';
  if (r.op === 'search' && (!str(r.query, 500) || !strList(r.types))) return 'catalog: bad search';
  if (r.op === 'doc' && (!str(r.fqcn) || !PLUGIN_NAME.test(r.fqcn)))
    return 'catalog: not a plugin name';
  return undefined;
}

/** Why a message from the webview is refused, or undefined when its shape is right. */
export function messageProblem(m: unknown): string | undefined {
  if (!isMap(m) || !str(m.type, 64)) return 'not a designer message';
  if ('reqId' in m && !optNum(m.reqId)) return `${m.type}: bad reqId`;
  switch (m.type) {
    case 'openCode':
      return str(m.path) && m.path !== '' && optNum(m.line) ? undefined : 'openCode: bad path';
    case 'openText':
      return m.path === undefined ||
        (Array.isArray(m.path) &&
          m.path.every((p) => str(p, 1000) || (typeof p === 'number' && Number.isInteger(p))))
        ? undefined
        : 'openText: bad path';
    case 'compareWith':
      return str(m.ref, 200) && GIT_REF.test(m.ref) ? undefined : 'compareWith: bad ref';
    case 'catalog':
      return catalogProblem(m.request);
    case 'openLink':
      return str(m.url) ? undefined : 'openLink: bad url';
    case 'copyText':
      return str(m.text, 10_000_000) && optNum(m.count) ? undefined : 'copyText: bad text';
    case 'command':
      return isMap(m.command) && str(m.command.kind, 64) ? undefined : 'command: bad command';
    case 'scenarioEdit':
      return isMap(m.request) ? undefined : 'scenarioEdit: bad request';
    case 'runScenarios':
      return strList(m.names) ? undefined : 'runScenarios: bad names';
    case 'lens':
      return m.lens === null || str(m.lens, 64) ? undefined : 'lens: bad lens';
    default:
      return undefined;
  }
}
