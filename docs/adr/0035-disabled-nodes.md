# ADR-0035: Disabled nodes: taken out before generation, not skipped at run time

- Status: accepted (2026-11-12, AFD-242, epic AFD-230)
- Context: other flow editors let a step be switched off without deleting it (n8n deactivate,
  Node-RED disable, ComfyUI bypass); here the only way to try a flow without a step was to delete
  it and wire the gap by hand

## Context

A disabled step must be kept in the flow, with its binding, contract and place on the canvas, and
must not take part in a run. Two questions decide the design: what happens to the hosts that reach
it, and what the generated code holds for it.

Product-owner decision (2026-11-12): a disabled node's tasks are omitted from the generated code.
"Users expect a disabled node does nothing."

## Decision

- **The field.** `disabled: true` on a node (any format; absent means enabled). Start and end
  nodes cannot be disabled: they are the ends of the path, not steps on it. Everything inside a
  disabled subflow is disabled with it.
- **Hosts pass through.** A disabled node goes on to where exactly one of its wired main outputs
  leads, the rule Delete uses to close a path (`core/flow/heal.ts`, AFD-235). A decision or a
  parallel with several ways on, or a step whose main output is open, cannot be passed through:
  the hosts that reach it stop there, and validation says so (`disabled-ends-path`).
- **One place switches it off.** Before the generator reads a flow, `withoutDisabled`
  (`core/engine/bypass.ts`) takes the disabled nodes out the way Delete with heal does: wires into
  a node go on to where it went on, its other wires go, a subflow's entry and exits are handed on,
  and a field that read its outputs loses its `from`. It runs at the top of `optionA.generate`,
  the one entry every caller uses (save, runs, AWX, the CLI, previews), so the generator itself
  knows nothing of disabled nodes. The scenario simulator runs the generator's plan, so it agrees
  without a rule of its own. The flow file is never changed by this; the result is kept per
  document object.
- **Nothing is generated for it.** No play, no file for a disabled subflow's level, no stub. Its
  fail ports cannot fire, so they are not open ports, and warnings about what it would do (its
  binding, its inputs) are dropped; errors stay.
- **What reads it is warned.** An input whose `from` reads an output of a disabled node gets
  `reads-disabled`: at run time the value is not there.
- **On the canvas.** `D`, or Disable / Enable on the node and selection menus (one edit for a
  selection, `setDisabled`); the node is drawn dashed and dimmed and says "Disabled · hosts pass
  through" in every mode. Find lists them with `has:disabled`. AI tools set it with
  `update_node` (`disabled: true`, `null` to enable).

## Alternatives

- **Generate the tasks with `when: false`.** The code would show the step and its stub would keep
  its place, but a disabled node would still register variables as skipped results, still count
  in `serial` batches and `max_fail_percentage`, and a reader of the playbook would have to know
  the convention. Rejected by the product-owner decision above.
- **Teach the generator and the simulator to skip disabled nodes.** Routing is worked out in
  several places of the generator (wiring, subflow exits, bubbling of fail ports, AWX segments).
  A rule in each would be easy to get wrong in one of them; taking the nodes out first reuses
  code that is already tested for deleting.
- **A status (`disabled` beside draft … tested).** The status says how far a step's design is;
  switching a step off must not lose that.

## Consequences

- A disabled node has no play, so Code mode and Run mode have nothing to show for it; it says
  "Disabled" there too. The drift check reports nothing for it.
- A scenario that forces an outcome on a disabled step forces nothing.
- `tested` drops back as for any design change: the flow that ran is not the flow now.
- Generation does one more parse and edit when a flow has disabled nodes, none when it has not.
- The Readiness counts in the flow panel do not count disabled steps apart (not done).
