// One round's test set (AFD-99): its cards, parts, workspace, outside change, checks and self-test,
// so the kit and the runner serve rounds 1-2 (variants A, B) and round 3 (variant C) alike.
import type { TaskCard } from './tasks';
import type { Check } from './verify';

export interface Part {
  title: string;
  /** What the runner says before the part's first task. */
  note: string;
}

export interface SessionDirs {
  workspace: string;
  profile: string;
  /** The extension's global storage: the run audit and the runs. */
  storage: string;
}

/** What the kit changed outside the designer when the task started. */
export interface OutsideChange {
  file: string;
  /** Shown to the participant under the goal. */
  message: string;
  /** Kept in session.json for the analysis. */
  facts?: Record<string, unknown>;
}

export interface Study {
  cards: TaskCard[];
  parts: Record<number, Part>;
  /** The intro's sentence after "You will do N tasks in Ansible Flow Designer,". */
  intro: string;
  /** Writes the workspace into an empty folder; one problems line per flow. */
  build(root: string): Promise<string[]>;
  outside(dirs: SessionDirs): Promise<OutsideChange>;
  verify(dirs: SessionDirs, answers: Record<string, string>): Check[];
  /** Self-test: what a participant would leave behind for the file-checked tasks. */
  solve(root: string): Promise<string>;
}
