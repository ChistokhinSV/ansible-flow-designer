// AFD-83 (wave 8 group I): what a lens shows, and why it shows nothing on this level. Round 1's
// participant turned the Inventory and Data lenses on and saw the canvas go quiet: chips appear only
// where a step has something for the lens, and nothing said so (P10).
import type { Ulid } from '../flow/types';
import { LENSES, type LensId, type LensView } from './types';

export interface LensCaption {
  lens: LensId;
  label: string;
  /** What the lens shows on each step. */
  what: string;
  /** Why no step on this level has anything for the lens; undefined when some step has. */
  empty?: string;
  /** The empty reason is fixed by setting the flow targets. */
  setTargets?: boolean;
}

/** Why the lens has nothing for any step of the level, per lens. */
const EMPTY: Record<LensId, string> = {
  inventory: 'No step on this level runs on hosts of its own.',
  data: 'No step on this level reads an input or sets an output.',
  code: 'No step on this level is bound to a module, role or playbook yet.',
  access:
    'No step on this level sets a credential, a user, become or vaulted variables: each acts as the run does.',
  timing: 'No step on this level has batches or timeouts, and no run has timed it yet.',
  changes: 'Nothing on this level changed since the version it compares with.',
};

export function lensCaption(
  lens: LensId,
  view: LensView | null,
  level: { id: Ulid; type: string }[],
  targets: string | undefined,
): LensCaption {
  const def = LENSES.find((l) => l.id === lens);
  const caption: LensCaption = { lens, label: def?.label ?? lens, what: def?.hint ?? '' };
  // The Inventory lens counts hosts from the flow targets: without them, no step has a count.
  if (lens === 'inventory' && !targets?.trim())
    return {
      ...caption,
      empty: 'The flow targets are not set, so the lens cannot count the hosts each step runs on.',
      setTargets: true,
    };
  if (!view) return caption;
  const steps = level.filter((n) => n.type !== 'start' && n.type !== 'end');
  const shown =
    steps.some((n) => (view.chips[n.id]?.length ?? 0) > 0) ||
    (lens === 'changes' && (view.ghosts?.length ?? 0) > 0);
  if (shown || steps.length === 0) return caption;
  return { ...caption, empty: view.notes[0] ?? EMPTY[lens] };
}
