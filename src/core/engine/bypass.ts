// AFD-242 (ADR-0035): the flow as it runs with its disabled nodes switched off. Before the
// generator reads a flow, each disabled node is taken out the way Delete takes one out
// (core/flow/heal): the wires into it go on to where it went on, its other wires go, a subflow's
// entry and exits are handed on, and a field that read its outputs loses its `from`. The generator
// and the scenario simulator (which runs the generator's plan) then see a flow without it, so its
// tasks are simply not there. The flow file is never changed: this is a view for generation.
import { parse, stringify } from 'yaml';
import { planCommand } from '../flow/commands';
import { disabledIds } from '../flow/disabled';
import { buildModel } from '../flow/model';
import type { FlowDocument } from '../flow/types';

const seen = new WeakMap<FlowDocument, FlowDocument>();

export function withoutDisabled(doc: FlowDocument): FlowDocument {
  const hit = seen.get(doc);
  if (hit) return hit;
  let out = doc;
  try {
    const ids = disabledIds(buildModel(doc));
    if (ids.length > 0) {
      const made = planCommand(
        stringify(doc),
        { kind: 'deleteNodes', ids, heal: true },
        {
          // Taking nodes out makes none.
          newId: () => {
            throw new Error('no new ids while bypassing disabled nodes');
          },
        },
      );
      out = parse(made.text) as FlowDocument;
    }
  } catch {
    // A flow that cannot be edited (no IDs yet, a broken level) generates as it is; its problems
    // are reported by validation.
    out = doc;
  }
  seen.set(doc, out);
  return out;
}
