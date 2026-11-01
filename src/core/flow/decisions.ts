// Decisions recorded with a reason (AFD-51, ADR-0025): what someone looked at and accepted. Format 1
// writes three kinds (open_on_purpose for a port, drift_ignored for a drift item, finding_accepted
// for a lens finding); format 2 writes one, `accepted`, keyed by what it accepts:
//   port:<port>, drift:<item>, lens:<finding id>, check:<code>[:<subject>]
// with the node it is about. Everything that reads decisions reads them here, in either format.
import { formatOf } from './format';
import type { Decision, FlowDocument, Ulid } from './types';

export type DecisionArea = 'port' | 'drift' | 'lens' | 'check';

export interface Accepted {
  area: DecisionArea;
  /** What is accepted in its area: the port, the drift item, the lens finding, the check. */
  what: string;
  node?: Ulid;
  reason?: string;
  by?: string;
  at?: string;
  /** Its place in `decisions`. */
  index: number;
}

const AREAS: readonly DecisionArea[] = ['port', 'drift', 'lens', 'check'];

/** The `finding` of a format 2 decision. */
export const findingOf = (area: DecisionArea, what: string) => `${area}:${what}`;

/** A check's `what`: its code, and what it is about when one node can have several. */
export const checkWhat = (code: string, subject?: string) =>
  subject ? `${code}:${subject}` : code;

function parse(finding: string): { area: DecisionArea; what: string } | undefined {
  const i = finding.indexOf(':');
  const area = finding.slice(0, i) as DecisionArea;
  return i > 0 && AREAS.includes(area) ? { area, what: finding.slice(i + 1) } : undefined;
}

/** One decision as what it accepts, or undefined for one this reader does not know. */
export function acceptedOf(d: Decision | null | undefined, index: number): Accepted | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const base = {
    index,
    ...(d.node ? { node: d.node } : {}),
    ...(d.reason !== undefined ? { reason: d.reason } : {}),
    ...(d.by ? { by: d.by } : {}),
    ...('at' in d && d.at ? { at: d.at } : {}),
  };
  switch (d.kind) {
    case 'open_on_purpose':
      return { ...base, area: 'port', what: d.port };
    case 'drift_ignored':
      return { ...base, area: 'drift', what: d.item };
    case 'finding_accepted':
      return { ...base, area: 'lens', what: d.finding };
    case 'accepted': {
      const p = parse(d.finding);
      return p ? { ...base, ...p } : undefined;
    }
    default:
      return undefined;
  }
}

/** Every decision as what it accepts. */
export function acceptedAll(doc: Pick<FlowDocument, 'decisions'>): Accepted[] {
  return (doc.decisions ?? []).flatMap((d, i) => acceptedOf(d, i) ?? []);
}

/** The decision for this area, node and thing, if there is one. */
export function findAccepted(
  doc: Pick<FlowDocument, 'decisions'>,
  area: DecisionArea,
  what: string,
  node?: Ulid,
): Accepted | undefined {
  return acceptedAll(doc).find(
    (a) => a.area === area && a.what === what && (node === undefined || a.node === node),
  );
}

/** Whether a fail port is open on purpose. */
export function portAccepted(
  doc: Pick<FlowDocument, 'decisions'>,
  node: Ulid,
  port: string,
): Accepted | undefined {
  return findAccepted(doc, 'port', port, node);
}

/** The YAML item a writer adds for a decision, in the document's format. */
export function decisionItem(
  doc: Pick<FlowDocument, 'schema_version'>,
  area: DecisionArea,
  what: string,
  node: Ulid | undefined,
  reason: string,
  by?: string,
): Record<string, string> {
  const who: Record<string, string> = by ? { by } : {};
  if (formatOf(doc) >= 2)
    return {
      kind: 'accepted',
      ...(node ? { node } : {}),
      finding: findingOf(area, what),
      reason,
      ...who,
    };
  switch (area) {
    case 'port':
      return { node: node as string, port: what, kind: 'open_on_purpose', reason, ...who };
    case 'drift':
      return { node: node as string, kind: 'drift_ignored', item: what, reason, ...who };
    default:
      return { kind: 'finding_accepted', finding: what, ...(node ? { node } : {}), reason, ...who };
  }
}

/** The same decision written in format 2 (the upgrade step, AFD-51). */
export function upgradedItem(a: Accepted): Record<string, string> {
  return {
    kind: 'accepted',
    ...(a.node ? { node: a.node } : {}),
    finding: findingOf(a.area, a.what),
    ...(a.reason !== undefined ? { reason: a.reason } : {}),
    ...(a.by ? { by: a.by } : {}),
    ...(a.at ? { at: a.at } : {}),
  };
}
