// What a node runs with from the subflows around it (AFD-52, decision 6: the code matches the
// settings). Format 2: `become` and `become_user` set on a subflow apply to the steps inside, the
// nearest setting winning, so a step can still say `become: false`. Format 1 keeps what it always
// generated: a node's own `become`, and `become_user` only as a task keyword.
import { formatOf } from './format';
import type { FlowModel } from './model';
import type { FlowNode, Ulid } from './types';

export interface Privilege {
  become?: boolean;
  become_user?: string;
  /** The subflow the setting comes from, when it is inherited. */
  from?: Ulid;
}

export function privilegeOf(model: FlowModel, node: FlowNode): Privilege {
  const own = node.settings ?? {};
  if (formatOf(model.doc) < 2) return own.become ? { become: true } : {};
  const out: Privilege = {};
  if (own.become !== undefined) out.become = own.become;
  if (own.become_user) out.become_user = own.become_user;
  for (
    let at = model.nodes.get(node.id)?.level;
    at && (out.become === undefined || out.become_user === undefined);
  ) {
    const entry = model.nodes.get(at);
    if (!entry) break;
    const s = entry.node.settings ?? {};
    if (out.become === undefined && s.become !== undefined) {
      out.become = s.become;
      out.from ??= entry.node.id;
    }
    if (out.become_user === undefined && s.become_user) {
      out.become_user = s.become_user;
      out.from ??= entry.node.id;
    }
    at = entry.level;
  }
  // AFD-160: become_user without become still names whom to become when ansible.cfg or the
  // inventory turns become on, as the task keyword did in format 1; dropping it made an upgraded
  // task run as root there. `become: false` turns both off.
  if (out.become === false || (!out.become && !out.become_user)) return {};
  return out;
}
