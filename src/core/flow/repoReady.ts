// AFD-384: the repository holding a file, once VS Code's Git extension has looked for it. Asked
// too early (a window just opened, the extension still scanning the folders), the Git extension
// answers "no repository", and a flow Git does not hold yet was taken for one outside Git: its
// first designer edit carried a version bump against the last saved text. Pure: the Git API is
// passed in, so this is tested without VS Code.

/** The few parts of vscode.git's API this needs (extensions/git/src/api/git.d.ts). */
export interface GitApiLike<R> {
  getRepository(uri: unknown): R | null;
  /** 'uninitialized' until the extension has scanned the workspace folders. */
  readonly state?: 'uninitialized' | 'initialized';
  onDidChangeState?(listener: (state: 'uninitialized' | 'initialized') => void): {
    dispose(): void;
  };
}

/**
 * The repository holding `uri`, or null when there is none. When the Git extension has not
 * finished its first scan, waits for it (at most `ms`) and asks again.
 */
export async function repositoryWhenReady<R>(
  api: GitApiLike<R>,
  uri: unknown,
  ms: number,
): Promise<R | null> {
  const now = api.getRepository(uri);
  if (now || api.state !== 'uninitialized' || !api.onDidChangeState) return now;
  const listen = api.onDidChangeState.bind(api);
  await new Promise<void>((done) => {
    const timer = setTimeout(finish, ms);
    const sub = listen((state) => {
      if (state === 'initialized') finish();
    });
    function finish() {
      clearTimeout(timer);
      sub.dispose();
      done();
    }
  });
  return api.getRepository(uri);
}
