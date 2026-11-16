// AFD-303: which flows of a folder connected to Ansible Flow Server are the project's. Each local
// flow is on the server as it is here, changed here (not sent yet), newer on the server (not here
// yet), or only here; the project's flows the folder does not have are listed apart. Paths are
// relative to the folder, with forward slashes, as the server names its flows.

export type ServerFlowState = 'same' | 'changed' | 'newer' | 'local';

export interface ServerFlows {
  /** Local flow path → its state. */
  states: Map<string, ServerFlowState>;
  /** The project's flows that are not in the folder. */
  missing: string[];
}

/**
 * `differs`: the flows whose text is not the server's (at the project's commit). `edited`: the
 * paths git says were changed here since that commit (working tree, index, untracked, commits);
 * a flow that differs and was not edited here is newer on the server.
 */
export function serverFlows(
  local: readonly string[],
  server: readonly string[],
  differs: ReadonlySet<string>,
  edited: ReadonlySet<string>,
): ServerFlows {
  const onServer = new Set(server);
  const here = new Set(local);
  const states = new Map<string, ServerFlowState>();
  for (const path of local)
    states.set(
      path,
      !onServer.has(path)
        ? 'local'
        : !differs.has(path)
          ? 'same'
          : edited.has(path)
            ? 'changed'
            : 'newer',
    );
  return { states, missing: server.filter((p) => !here.has(p)).sort() };
}

/** The same text, whatever line ends git checked it out with. */
export const sameText = (a: string, b: string) =>
  a.split('\r\n').join('\n') === b.split('\r\n').join('\n');

/** Words for the pane. */
export const SERVER_STATE_WORDS: Record<ServerFlowState, { short: string; long: string }> = {
  same: { short: 'on server', long: 'On the server, as it is here.' },
  changed: {
    short: 'changed here',
    long: 'On the server, changed here: commit and push to send the change.',
  },
  newer: {
    short: 'newer on server',
    long: 'The server has a newer version: pull to get it.',
  },
  local: {
    short: 'only here',
    long: 'Only in this folder: the server project does not have it (commit and push to add it).',
  },
};

/**
 * The paths `git status --porcelain=v1 -z` names: changed, staged, untracked, both sides of a
 * rename. Paths as git writes them (relative to the repository, forward slashes).
 */
export function porcelainPaths(z: string): string[] {
  const out: string[] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? '';
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    out.push(entry.slice(3));
    // A rename or copy is followed by its old path.
    if (/[RC]/.test(xy)) {
      const from = parts[i + 1];
      if (from) out.push(from);
      i++;
    }
  }
  return out;
}
