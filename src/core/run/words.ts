// AFS-153: a run told in its host's words. VS Code calls a check-mode run a skeleton run and
// shows Ansible's exit code, as its terminal does. A page of Ansible Flow Server says check run,
// went well, failed and stopped, as the pages around the canvas do; the page says so in its
// ViewerEmbed (`words: 'server'`).
export type RunWords = 'designer' | 'server';

/** "1 host", "4 hosts". */
export const hostsWord = (n: number): string => `${n} ${n === 1 ? 'host' : 'hosts'}`;

/** The run button for a check-mode run. */
export const checkButton = (words: RunWords): string =>
  words === 'server' ? 'Run a Check' : 'Run as Skeleton';

/** A check-mode run in a phrase: "skeleton run" or "check run". */
export const checkRun = (words: RunWords): string =>
  words === 'server' ? 'check run' : 'skeleton run';

/** The run's mode as one word in a list line: "skeleton" or "check". */
export const checkWord = (words: RunWords): string => (words === 'server' ? 'check' : 'skeleton');
