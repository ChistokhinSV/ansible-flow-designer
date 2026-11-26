// AFD-381: hooks for a page that holds the canvas and has its own debug toolbar (Ansible Flow
// Server's debug workbench, config.hostToolbar): the page is told which node is selected, and the
// canvas marks the steps of the host the page picked.
import { modelOf } from '../core/flow/model';
import type { Ulid } from '../core/flow/types';
import { type HostMark, hostMarks, hostTrail } from '../core/run/hostTrail';
import { send } from './bus';
import { useUi } from './store';

type Ui = ReturnType<typeof useUi.getState>;

/**
 * Sends `nodeSelected` (one node, else null) when the selection changes and when the host turns its
 * toolbar on. Nothing is sent without config.hostToolbar (VS Code).
 */
export function reportSelection(): () => void {
  let last: Ulid | null | undefined;
  const report = (s: Ui) => {
    if (!s.hostToolbar) {
      last = undefined;
      return;
    }
    const node = s.selection.node ?? null;
    if (node === last) return;
    last = node;
    send({ type: 'nodeSelected', node });
  };
  return useUi.subscribe((s, before) => {
    if (s.selection !== before.selection || s.hostToolbar !== before.hostToolbar) report(s);
  });
}

let marks: {
  doc: unknown;
  run: unknown;
  host: string;
  level: string;
  marks: Record<Ulid, HostMark>;
} | null = null;

/**
 * How node `id` shows the host the page picked (`highlightHost`): `at` where it waits, `ran` where
 * it went, `off` where it did not; undefined with no host picked or no run shown (Run mode only).
 * Worked out once per run, host and level, not once per node.
 */
export function hostMarkOf(s: Ui, id: Ulid): HostMark | 'off' | undefined {
  const doc = s.snapshot?.doc;
  if (s.mode !== 'run' || !s.hostMark || !s.run || !doc) return undefined;
  if (
    !marks ||
    marks.doc !== doc ||
    marks.run !== s.run ||
    marks.host !== s.hostMark ||
    marks.level !== s.level
  ) {
    const trail = hostTrail(doc, s.run, s.hostMark);
    marks = {
      doc,
      run: s.run,
      host: s.hostMark,
      level: s.level,
      marks: hostMarks(modelOf(doc), trail, s.level),
    };
  }
  return marks.marks[id] ?? 'off';
}
