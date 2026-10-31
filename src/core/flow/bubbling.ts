// Fail ports bubble out of subflows (ADR-0004). A step's fail port that nothing takes in its level
// (no wire, no boundary exit) leaves through the enclosing subflow's port of the same name when the
// subflow has that port; otherwise it is open. One rule for the open-port banner, the generated
// routing, the subflow frame, the boundary check and Extract into Subflow (AFD-40).
import { isFailPort, portsFor } from './ports';
import type { FlowDocument, FlowNode, PortRef, Ulid } from './types';

export const portKey = (node: Ulid | undefined, port: string | undefined): string =>
  `${node}|${port}`;

/** What takes the ports of one level's steps: wires inside it, and the parent's boundary exits. */
export interface LevelTaken {
  /** `node|port` of every wire's source in the level. */
  wired: ReadonlySet<string>;
  /** `node|port` of every exit of the level's subflow (`boundary.outputs`). */
  exits: ReadonlySet<string>;
}

export function levelTaken(
  edges: readonly ({ from?: Partial<PortRef> } | null | undefined)[],
  parent: FlowNode | undefined,
): LevelTaken {
  return {
    wired: new Set(edges.map((e) => portKey(e?.from?.node, e?.from?.port))),
    exits: new Set(
      Object.values(parent?.subflow?.boundary?.outputs ?? {}).flatMap((refs) =>
        (refs ?? []).map((r) => portKey(r?.node, r?.port)),
      ),
    ),
  };
}

/** The node shows this port (a default one, or an optional one it enables). */
export function hasPort(node: FlowNode | undefined, port: string): boolean {
  return !!node && portsFor(node).some((p) => p.name === port);
}

/** Neither wired in the level nor a boundary exit. */
export function untaken(node: Ulid, port: string, level: LevelTaken): boolean {
  const key = portKey(node, port);
  return !level.wired.has(key) && !level.exits.has(key);
}

/** The step's output fail ports that nothing takes in its level. */
export function untakenFailPorts(node: FlowNode, level: LevelTaken): string[] {
  return portsFor(node)
    .filter((p) => p.direction === 'out' && p.fail && untaken(node.id, p.name, level))
    .map((p) => p.name);
}

/** `node.port` leaves its level through `parent`'s port of the same name. */
export function bubbles(
  parent: FlowNode | undefined,
  node: Ulid,
  port: string,
  level: LevelTaken,
): boolean {
  return isFailPort(port) && untaken(node, port, level) && hasPort(parent, port);
}

/** Some inner step's port bubbles into `parent.port`, so hosts can leave the subflow by it. */
export function fedByBubbling(
  parent: FlowNode,
  port: string,
  inner: readonly FlowNode[],
  level: LevelTaken,
): boolean {
  return inner.some((n) => hasPort(n, port) && bubbles(parent, n.id, port, level));
}

/**
 * Module hosts that turn unreachable on a step without the `unreachable` port: they bubble to the
 * enclosing subflow's `unreachable` when it has one, else they fail in the outcome play.
 */
export function unreachableBubbles(parent: FlowNode | undefined): boolean {
  return hasPort(parent, 'unreachable');
}

/** `node|port` of every port left open on purpose (D-15). */
export function openOnPurpose(doc: FlowDocument): Set<string> {
  return new Set(
    (doc.decisions ?? [])
      .filter((d) => d?.kind === 'open_on_purpose')
      .map((d) => portKey(d.node, d.port)),
  );
}
