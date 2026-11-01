# ADR-0018 · Data across subflow boundaries, polling, pattern ends

Status: Accepted · 2026-10-31 · AFD-21

## Context

In the second real use of the AI assistants (0.15.1), an agent built a FortiGate upgrade flow with seven subflows and reported:
- an inner step could not read its subflow's input (`rollback.backup_file` was `from-unresolved`), nor a step inside another subflow (`precheck/normalize-facts.fos_platform`);
- `retries` could not poll until a state (the generator wrote `until: <reg> is succeeded`);
- `stop` and `notify-stop` wired a rejected approval and a failed rollback to "Rolled back", the only failed end on the level;
- `assert` `that:` and decision conditions were not checked;
- the `flow_edit` answer said "3 solved" when 11 warnings went away;
- local approvals approved automatically, with a message that still named M7.

The agent assumed the unresolved data "works at runtime because host facts persist". For `backup_file` it did not: the `backup` subflow output had no `from`, the inner step registered `store_backup_result.dest`, and nothing set `backup_file`.

Decisions (product owner, 2026-10-31):
1. Inside a subflow, an inner step declares an input `from: <that subflow>.<input>`. The @ picker offers the enclosing subflows' inputs.
2. A path into another subflow (`sub/step.output`) is lifted by the tools and the @ picker: the subflow gets an output, and the reference reads it. The file stays encapsulated.
3. A subflow output without `from` lifts the only inner output of the same name; otherwise a warning.
4. Polling: `settings.until` (a Jinja test without braces, reading the registered result by name and the inputs) and `settings.delay` (seconds).
5. Patterns reuse an end only by key; `apply_pattern` takes an `end`.
6. Local runs take the extra var `afd_approvals` to choose an approval's outcome.
7. The @ picker lifts too.

## Decision

**One resolver** (`core/flow/dataRefs.ts`, pure) for the validator, the generator, the data lens and the commands:
- `resolveFrom(model, node, level, side, from)` returns a flow input, an output of a node the reader sees, an enclosing subflow's input, `impl`, or unresolved with the fix in words;
- inside a subflow, `<subflow>.<name>` always means its input: its outputs are computed inside, so reading them there would be circular;
- `liftOf(subflow, output)` names the inner step an output reads: by `from`, else the one inner step with an output of that name.

**Generation** (`engine/binding.ts`):
- `sourceExpr` follows a subflow input to its own `from`, on the subflow's level, so an inner step gets the upstream variable (`{{ store_result.dest }}`). Subflow inputs still compile to nothing themselves: host variables persist across the imported level files;
- `outputVar` (`core/flow/dataNames.ts` since AFD-40) uses `liftOf`, so same-name outputs read the inner variable;
- `until` replaces `<reg> is succeeded`, and `delay` is written only with a condition.

**Commands** (`flow/commands.ts`):
- `setContractField`, `setBinding` and `addNode` lift `from: sub/…/step.output` from the inside out. Each subflow reuses an output that lifts the same thing, else adds one; a name taken by something else gets the step key as a prefix, as extraction does (AFD-7). `CommandResult.notes` says what was lifted;
- a subflow input rename rewrites the inner reads; an output rename skips them;
- `applyPattern` takes `end`, checks its type, level and outcome, and notes the end used.

**Validation:** `from-unresolved` messages come from the resolver. New codes: `subflow-output-unset`, `condition-unknown-var` (decision conditions, `until`) and `until-not-module`. `binding-unknown-var` also reads `assert` `that` and `debug` `var`. Unknown names get a hint: the enclosing subflow's input, an upstream output, or a step inside an upstream subflow to lift.

**Patterns:** `EndRecipe.anyOutcome` is removed. An end is reused when its key is in the recipe's `prefer` list, else a new one is made.

**Approvals:** each local approval play sets `afd_approval` from `afd_approvals['<key path>']` (default `approved`), fails when the value names a port the approval lacks, and routes on it before the simulation choices. The header of the whole-flow playbook names the approvals and shows the extra var. AWX workflow segments are unchanged (ADR-0016).

**AI tools:** the `flow_edit` problem diff keys findings by code, place and message (the node's title taken out) and counts them per key. describe shows `register:` for polling steps and `(same name)` lifts.

## Consequences

- An inner step's design now shows where its data comes from, and the generated code passes it explicitly instead of relying on a fact of the same name.
- Flows that read facts directly in conditions or asserts get new warnings. That is the point: those were the reads the agent got wrong.
- Same-name lifting is implicit; describe and the warning make it visible.
- An end node per pattern can mean more end nodes than before; `end` lets the author merge them.
- Engine tests run the new data paths, polling and `afd_approvals` on ansible-core 2.19–2.21.

## Amendment: what a reference really reads (AFD-31, 2026-10-31)

Found in the improvement review (KB AFD-A-17): a `from:` looks scoped to a node, but an output that is not register-based compiles to a host fact named after the output (`outputVar`), and `resolveFrom` checks that the key is visible, not that the producer ran.

- `output-name-collision` (warning, at the reader): the reference's host variable (the root of `outputVar`, following subflow lifts to the producing step) is also set by another step's output, or is a flow input name (an extra var, which always wins).
- `ref-may-be-undefined` (warning, at the reader): on the producer's level, the reader (or the subflow holding it) is reachable from the level's entry (the start nodes, or the subflow's `boundary.in`) without passing the producer, or is reachable from the producer's fail-port wires. Skipped when the input has a `default` or every use in the binding goes through `| default(…)` (imported handlers).
- The generated code is unchanged; AFD-53 (per-node capture) removes the collision itself.
- **AFD-53 amendment:** outputs other than registers are captured into the step's own variable (`afd_<key>__<output>`, ADR-0009), so `output-name-collision` is gone. A register read by another step's input that another step also registers, or that a flow input names, is the error `register-collision`.
