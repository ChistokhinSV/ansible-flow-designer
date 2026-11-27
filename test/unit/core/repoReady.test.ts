import { describe, expect, it } from 'vitest';
import { type GitApiLike, repositoryWhenReady } from '../../../src/core/flow/repoReady';

/** A Git API that finds the repository only once its first scan is done, as in a fresh window. */
function scanning(after: number) {
  let state: 'uninitialized' | 'initialized' = 'uninitialized';
  const listeners = new Set<(s: 'uninitialized' | 'initialized') => void>();
  const api: GitApiLike<{ root: string }> = {
    getRepository: () => (state === 'initialized' ? { root: '/work' } : null),
    get state() {
      return state;
    },
    onDidChangeState(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  setTimeout(() => {
    state = 'initialized';
    for (const l of listeners) l(state);
  }, after);
  return { api, listeners };
}

describe('AFD-384: the repository of a flow, once Git has looked', () => {
  it('waits for the first scan instead of taking the flow for one outside Git', async () => {
    const { api, listeners } = scanning(20);
    // Asked at once, the Git extension says "no repository": that made the first edit bump.
    expect(api.getRepository('/work/flows/site/site.flow.yaml')).toBeNull();
    await expect(
      repositoryWhenReady(api, '/work/flows/site/site.flow.yaml', 1000),
    ).resolves.toEqual({ root: '/work' });
    expect(listeners.size).toBe(0);
  });

  it('answers at once when Git has scanned, also when there is no repository', async () => {
    const api: GitApiLike<object> = {
      getRepository: () => null,
      state: 'initialized',
      onDidChangeState: () => {
        throw new Error('not listened to');
      },
    };
    await expect(repositoryWhenReady(api, '/elsewhere/a.flow.yaml', 1000)).resolves.toBeNull();
  });

  it('gives up after its budget when the scan never ends', async () => {
    const { api, listeners } = scanning(10_000);
    const start = Date.now();
    await expect(repositoryWhenReady(api, '/work/a.flow.yaml', 30)).resolves.toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
    expect(listeners.size).toBe(0);
  });
});
