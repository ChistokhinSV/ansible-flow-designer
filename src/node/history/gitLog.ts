// AFD-320: the project's history from git: commits with who, when, the message and the files each
// one changed, for the History view and a flow's history. One `git log -z --name-status` call reads
// a page of commits; the parser below is pure, so it is tested without a repository.
import { git } from '../runner/projectGit';

export interface ChangedFile {
  /** A (added), M (modified), D (deleted), R (renamed), C (copied), T (type changed). */
  status: string;
  path: string;
  /** The path before a rename or copy. */
  from?: string;
}

export interface Commit {
  hash: string;
  /** Parent hashes; none for the first commit, two for a merge. */
  parents: string[];
  author: string;
  email: string;
  /** ISO 8601 author date. */
  date: string;
  subject: string;
  body: string;
  files: ChangedFile[];
}

const RS = '\x1e';
const US = '\x1f';
/** One commit: a record separator, then its fields, then the files (name-status, NUL separated). */
export const LOG_FORMAT = `${RS}%H${US}%P${US}%an${US}%ae${US}%aI${US}%s${US}%b${US}`;

/** `git log -z --name-status --format=LOG_FORMAT` as commits. */
export function parseLog(text: string): Commit[] {
  const out: Commit[] = [];
  for (const chunk of text.split(RS)) {
    if (!chunk.trim()) continue;
    const parts = chunk.split(US);
    if (parts.length < 8) continue;
    const [hash = '', parents = '', author = '', email = '', date = '', subject = '', body = ''] =
      parts;
    const tokens = parts.slice(7).join(US).split('\0');
    const files: ChangedFile[] = [];
    let i = 0;
    const next = () => (tokens[i++] ?? '').replace(/^\n+/, '');
    while (i < tokens.length) {
      const status = next();
      if (!status) continue;
      const letter = status[0] as string;
      if (letter === 'R' || letter === 'C') {
        const from = next();
        const path = next();
        if (path) files.push({ status: letter, path, from });
      } else {
        const path = next();
        if (path) files.push({ status: letter, path });
      }
    }
    out.push({
      hash: hash.trim(),
      parents: parents.trim() ? parents.trim().split(' ') : [],
      author,
      email,
      date,
      subject,
      body: body.trim(),
      files,
    });
  }
  return out;
}

export interface LogQuery {
  /** Commits to skip (the pages before). */
  skip?: number;
  /** At most this many commits. */
  max?: number;
  /** Only commits that changed one of these paths (relative to the repository root). */
  paths?: string[];
  /** The commit to start from; HEAD by default. */
  from?: string;
}

/**
 * A page of the history of the repository at `root`, newest first. A repository without commits
 * yet has none. Renames are followed within each commit (-M), not across a path's history.
 */
export async function readLog(root: string, query: LogQuery = {}): Promise<Commit[]> {
  const args = [
    '-c',
    'core.quotePath=false',
    'log',
    '-z',
    '-M',
    '--name-status',
    `--format=${LOG_FORMAT}`,
    `--max-count=${query.max ?? 100}`,
    ...(query.skip ? [`--skip=${query.skip}`] : []),
    ...(query.from ? [query.from] : []),
    '--',
    ...(query.paths ?? []),
  ];
  try {
    return parseLog(await git(root, args, undefined, 30_000, true));
  } catch (e) {
    if (/does not have any commits|bad default revision|unknown revision/i.test(String(e)))
      return [];
    throw e;
  }
}

/** The repository's top folder holding `folder`, or undefined outside a repository. */
export async function repositoryRoot(folder: string): Promise<string | undefined> {
  try {
    return await git(folder, ['rev-parse', '--show-toplevel'], undefined, 15_000);
  } catch {
    return undefined;
  }
}

/** A file's text at a commit (`git show <hash>:<path>`), or undefined when that commit has none. */
export async function textAtCommit(
  root: string,
  hash: string,
  path: string,
): Promise<string | undefined> {
  // Only a hash (or hash^) reaches git: never an option.
  if (!/^[0-9a-f]{4,64}\^?$/i.test(hash)) return undefined;
  try {
    return await git(root, ['show', `${hash}:${path}`], undefined, 30_000, true);
  } catch {
    return undefined;
  }
}

/** Matches a commit against a filter: words in its message, author, email, hash or file paths. */
export function commitMatches(commit: Commit, filter: string): boolean {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = [
    commit.hash,
    commit.author,
    commit.email,
    commit.subject,
    commit.body,
    ...commit.files.flatMap((f) => [f.path, f.from ?? '']),
  ]
    .join('\n')
    .toLowerCase();
  return words.every((w) => hay.includes(w));
}
