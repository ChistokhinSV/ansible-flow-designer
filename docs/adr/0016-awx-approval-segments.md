# ADR-0016 · AWX approval segments

Status: Accepted · 2026-10-30 · AFD-11

## Context

ADR-0003 puts approvals between playbook segments of an AWX workflow; the M3 spike (s10) showed that `add_host` over an artifact variable rebuilds routing groups in the next segment. M7 (ADR-0013) launched one job, with approvals auto-approved. AWX approvals decide for the whole workflow, not per host: approving sends the workflow down the success edge, and denying or timing out sends it down the failure edge.

Decisions by the user at the start of AFD-11:
1. Approvals at the top level of the flow, one waiting at a time. Other flows get a validator error for AWX workflows; local and skeleton runs auto-approve them as before.
2. When no host reaches an approval, AWX skips it: the workflow finishes without asking anyone.
3. Run mode shows the approval's state and links to it in AWX. No approve or deny from VS Code.
4. Segment playbooks are generated on save, next to the full playbook.

Spike (lab AWX 24.6.1, 2026-10-30):
- `set_stats` artifacts reach the job after an approval node;
- they still arrive after a job that set them and then failed, on its failure edge;
- workflow extra vars reach every node, even when its template does not prompt for variables;
- a failed job with a failure handler leaves the workflow successful.

## Decision

**Segments** (`core/engine/segments.ts`, pure):
- `start` holds the top-level nodes reachable from start without passing an approval;
- an approval in a segment is its gate;
- `<gate>-approved` holds what the gate's approved port reaches;
- `<gate>-rejected` holds what its rejected and timeout ports reach (AWX cannot tell them apart; the validator already warns when they go to different targets);
- nested gates prefix their parent segment's name;
- `finish` runs only the outcome.

A node reachable both before and after a gate is in both segments; a subflow node imports its shared level file.

Problems (`codegen-segments`, validator `awx-segments`) are:
- two approvals in one segment (both could wait at once);
- an approval inside a subflow;
- more than 32 segments.

They are warnings, and errors once `runtime.kind` is `awx_workflow`. The runtime kind is inferred as `awx_workflow` only for flows that split.

**What crosses a segment.** Every routing group has one consumer, the node its port is wired to. Producer and consumer sit in the same segment, except at the gate. At the end of a segment only two kinds of hosts are still in flight: those waiting at the gate, and those bound for the outcome (open fail ports, failed ends). So:
- the gate's play puts its arriving hosts into `flow_<gate>_waiting`;
- the last play (localhost) publishes `set_stats` `afd_hostsets` (each of those groups with its hosts) and `afd_gate_empty`. It then fails the job when nobody waits, which takes AWX's failure edge to `finish`;
- a continuation starts with an `add_host` loop that restores `afd_hostsets`. Next, a `[gate] Title: route` play runs on the waiting hosts and routes them to the gate's `approved` or `rejected` group;
- the start edge is not followed in continuations, and a node never runs twice for the same hosts.

Hosts are failed only in leaf segments and in `finish`, whose outcome play is the whole flow's. Earlier segments carry the outcome groups, so a segment job fails only for the empty gate. `finish` first checks `afd_gate_empty`: after any other failure of the job before it, it fails ("did not finish") instead of reporting success.

**Files.** `generated/<key>.seg_<segment>.yml` is written on save when the flow splits, after the level files. Underscores never occur in keys, so the names cannot collide with level files. The header says the AWX workflow runs the file. The single playbook `<key>.yml` stays the one local and skeleton runs use, auto-approving.

**AWX** (`extension/awx/awxWorkflow.ts`). _Set Up AWX Template_ on a flow that splits:
- checks that every segment playbook is in the project (one project update if not);
- creates or updates a job template per segment, `AFD · <key> · <segment>`, with the same project, inventory, EE and credentials as the picks;
- rebuilds the workflow `AFD · <key>` (with `ask_variables_on_launch`). Each gated segment's success edge leads to an approval node `[gate] Title` (timeout from `settings.timeout`), and its failure edge to a `finish` node. The approval's success edge leads to `<gate>-approved`, its failure edge to `<gate>-rejected`;
- writes `runtime: {kind: awx_workflow, template}`.

_Launch in AWX_:
- launches the workflow with the flow inputs as extra vars (the confirmation names its approvals);
- follows the workflow job and its nodes. Each segment job's events are converted as in M7 and summarized in job order with the whole build's routes;
- localhost bookkeeping (restore, carry, the empty-gate stop) is not a host or a failure of the flow;
- each approval shows `waiting`, `approved`, `denied` or `timed out` (from `timed_out`), with its AWX page;
- the run passes rc 0 when the workflow job succeeded.

The audit log records the workflow launch and finish.

**Run mode.**
- The approval node shows its AWX decision and how many hosts it decided for.
- Its panel opens the approval in AWX; the host resolves the URL, the webview never sends one.
- The run panel lists the segment jobs.
- The top bar shows "waiting for approval" while one waits.

**Events.** The `afd_events` callback adds `set_stats` data (`custom`) to its `stats` event. The engine contract tests chain segment runs the way AWX does: a segment's custom stats become the next segment's extra vars.

**Tests.**
- **Unit (`segments.test.ts`):**
  - plans of the fixture and the examples, including the M9 import where notify sits on both sides;
  - problems;
  - the shape of every segment file;
  - the validator.
- **Webview (`approval.test.tsx`):** the waiting node, the AWX link, the segment list, the top bar.
- **Engine (2.19–2.21):** approved, rejected and empty-gate chains. Failures fail in the last segment; a node shared across the gate runs once per host; the empty gate stops start and `finish` fails the right hosts.
- **Lab (`just test-awx`):** setup builds the 5 workflow nodes. Approved, denied and empty-gate launches give the designed ports, outcome, approval state and segment list.

## Consequences

- An approval decides for every host waiting at it, as AWX does: per-host approval does not exist.
- Hosts that are not waiting at the gate (they took other paths) are not held back by it: they finish in the segment where they are, and fail, if they must, at the end.
- The empty-gate job shows as failed in AWX, with "No host reached …"; the workflow itself succeeds.
- Approvals inside subflows, and parallel approvals, still run only locally and as skeletons (auto-approved) until a later change lifts the scope.
