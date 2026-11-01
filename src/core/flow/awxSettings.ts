// AWX credentials and execution environment (AFD-52, decision 6: the code matches the settings).
// An AWX job or workflow template has one set of credentials and one execution environment, so in
// format 2 they belong to the flow (`flow.runtime`), next to the template's name, and Set Up AWX
// Template applies them. Format 1 let every node name its own, which nothing ever applied.
import type { FlowDocument, Ulid } from './types';
import { walkNodes } from './walk';

export interface AwxLift {
  credentials: string[];
  execution_environment?: string;
  /** Execution environments the nodes named besides the one kept. */
  otherEnvironments: string[];
  /** Nodes that named either. */
  nodes: Ulid[];
}

/** What the nodes of a format 1 flow (or an import) name, as the flow's runtime would keep it. */
export function awxLift(doc: Pick<FlowDocument, 'nodes' | 'flow'>): AwxLift {
  const credentials = new Set<string>(doc.flow.runtime?.credentials ?? []);
  const environments: string[] = [];
  const nodes: Ulid[] = [];
  for (const n of walkNodes(doc.nodes)) {
    const s = n.settings;
    if (!s?.credential && !s?.execution_environment) continue;
    nodes.push(n.id);
    if (s.credential) credentials.add(s.credential);
    if (s.execution_environment && !environments.includes(s.execution_environment))
      environments.push(s.execution_environment);
  }
  const kept = doc.flow.runtime?.execution_environment ?? environments[0];
  return {
    credentials: [...credentials],
    ...(kept ? { execution_environment: kept } : {}),
    otherEnvironments: environments.filter((e) => e !== kept),
    nodes,
  };
}

/** The same document with the nodes' credentials and environment on the flow (format 2 writers). */
export function withAwxRuntime<T extends FlowDocument>(doc: T): T {
  const lift = awxLift(doc);
  if (lift.nodes.length === 0) return doc;
  const out = structuredClone(doc);
  for (const n of walkNodes(out.nodes)) {
    if (!n.settings) continue;
    delete n.settings.credential;
    delete n.settings.execution_environment;
    if (Object.keys(n.settings).length === 0) delete n.settings;
  }
  const runtime = {
    ...out.flow.runtime,
    ...(lift.credentials.length ? { credentials: lift.credentials } : {}),
    ...(lift.execution_environment ? { execution_environment: lift.execution_environment } : {}),
  };
  // Where the designer writes it: after the owner, before where an import came from.
  const { imported_from, maintenance_window, inputs, ...head } = out.flow;
  out.flow = {
    ...head,
    runtime,
    ...(imported_from ? { imported_from } : {}),
    ...(maintenance_window ? { maintenance_window } : {}),
    ...(inputs ? { inputs } : {}),
  };
  return out;
}
