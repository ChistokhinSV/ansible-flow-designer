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

/**
 * AFD-359: a run whose failing hosts all ended through an approval's decision (the generator's
 * "Rejected at ..." / "No decision in time at ..." before the failed end) was decided against,
 * not broken: `rejected` or `timed out`; undefined for any other run.
 */
export function decidedAgainst(summary: {
  outcome: Record<string, string>;
  failures: readonly unknown[];
  unreachable?: readonly string[];
}): 'rejected' | 'timed out' | undefined {
  const ends = Object.values(summary.outcome);
  if (!ends.length || summary.failures.length || summary.unreachable?.length) return undefined;
  const rejected = ends.filter((e) => e.startsWith('Rejected at ')).length;
  const late = ends.filter((e) => e.startsWith('No decision in time at ')).length;
  if (rejected + late !== ends.length) return undefined;
  return rejected ? 'rejected' : 'timed out';
}

/**
 * AFD-359: where a host ended, as a server's page says it: step keys in brackets left out, and an
 * end reached by a decision says so ("(outcome: rejected)").
 */
export function outcomeWords(text: string, words: RunWords): string {
  if (words !== 'server') return text;
  const plain = text.replace(/\[[\w.-]+\] (?=\S)/g, '');
  if (plain.startsWith('Rejected at '))
    return plain.replace('(outcome: failed)', '(outcome: rejected)');
  if (plain.startsWith('No decision in time at '))
    return plain.replace('(outcome: failed)', '(outcome: not decided in time)');
  return plain;
}
