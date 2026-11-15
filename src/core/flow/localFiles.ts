// Files a step reads from the repository (AFD-291): a template's or a copy's source, a script, a
// vars file. Generated plays run from flows/<key>/generated, where Ansible would look for them, so a
// relative path in a step means the repository root: the generator writes it from
// `{{ afd_repo_root }}`, and the host warns when the file is not there. Import (AFD-176) already
// writes the paths it finds that way, searched as Ansible does from the source playbook.
import { shortName } from '../import/builtins';

/** Modules that read a local file, the parameter naming it and the subfolder Ansible looks in. */
export const LOCAL_FILES: Record<string, { param: string; sub: string }> = {
  template: { param: 'src', sub: 'templates' },
  win_template: { param: 'src', sub: 'templates' },
  copy: { param: 'src', sub: 'files' },
  win_copy: { param: 'src', sub: 'files' },
  unarchive: { param: 'src', sub: 'files' },
  script: { param: 'cmd', sub: 'files' },
  include_vars: { param: 'file', sub: 'vars' },
};

/** The variable generated plays set to the repository root. */
export const REPO_ROOT_VAR = 'afd_repo_root';

const truthy = (v: unknown) =>
  v === true || (typeof v === 'string' && /^(yes|true|on|1)$/i.test(v.trim()));

/**
 * The repository file a module step names by a relative path, as written; undefined when it names
 * none (another module, a remote source, an absolute or templated path).
 */
export function localFileOf(
  module: string,
  params: unknown,
): { param: string; path: string } | undefined {
  const spec = LOCAL_FILES[shortName(module).replace(/^ansible\.windows\./, '')];
  if (!spec || !params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const map = params as Record<string, unknown>;
  if (truthy(map.remote_src)) return undefined;
  let written = map[spec.param];
  if (spec.param === 'cmd' && typeof written === 'string') written = written.trim().split(/\s+/)[0];
  if (typeof written !== 'string' || !written.trim()) return undefined;
  const path = written.trim();
  if (path.includes('{{') || path.includes('{%') || /^([/~\\]|[A-Za-z]:)/.test(path))
    return undefined;
  return { param: spec.param, path: path.replace(/^\.\//, '') };
}

/** The params with a relative repository file written from `{{ afd_repo_root }}`. */
export function rootedParams(module: string, params: unknown): unknown {
  const file = localFileOf(module, params);
  if (!file) return params;
  const map = { ...(params as Record<string, unknown>) };
  const rooted = `{{ ${REPO_ROOT_VAR} }}/${file.path}`;
  map[file.param] =
    file.param === 'cmd' && typeof map.cmd === 'string'
      ? map.cmd.replace(/^\s*\S+/, rooted)
      : rooted;
  return map;
}
