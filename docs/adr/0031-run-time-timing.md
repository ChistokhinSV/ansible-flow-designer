# ADR-0031: Timing given at run time

- Status: accepted (2026-11-07, AFD-112)
- Context: usability round 4, Q4 (`docs/ux/wave10-usability/round4.md`)

## Context

Round 4's D6 asked the participant to let the operator set the pool drain wait: 300 seconds unless
they give another number. The participant made no flow input and wrote the wait into the flow's
goal. There were two causes:

- **The task card:** it named the wait that D2 had just set with Retries and Delay.
- **The product:** Retries and Delay took only numbers, so no input could drive a wait. Nothing on
  the way connected "a value given at run time" to a step's Timing.

Ansible renders a task's `retries`, `delay` and `timeout` before the task runs (`post_validate` in
`task_executor.py`, before the retry loop). Checked in afd-ee:2.19:

- `retries: "{{ drain_tries }}"` with `-e drain_tries=3` (a string) makes 4 tries;
- templated delay and timeout apply;
- a try that hits the timeout ends the task with no more tries.

Product-owner decisions (2026-11-07):

- The three fields take an input, as Ansible templates them. The designer adds no "wait up to"
  total of its own: a total is an expression in Retries.
- Each field gets an "Ask at run time…" action.
- Format 2 is widened; there is no format 3.
- Only Retries, Delay and Timeout. An approval's timeout stays a duration, because AWX needs a
  number.

## Decision

- **Format.**
  - `settings.retries` and `settings.delay` are an integer or a whole template:
    `^\s*\{\{[\s\S]*\}\}\s*$`, tested by `templated()` in `core/flow/jinja.ts`.
  - `settings.timeout` was already a string.
  - The schema widens in place: no migration step and no `requireFormat`.
  - **Cost:** a designer before 0.69 shows a schema error on a flow that uses a templated retries
    or delay, and does not generate it (`writePlan` refuses errors). Flows that do not use one are
    unaffected. A templated timeout already passed the schema; older designers warned
    `timeout-unreadable` and generated without it.
  - **Why not format 3:** every older designer would then reject every upgraded flow, for one
    optional value type. ADR-0025 keeps a new format for changes of shape.
- **Codegen.**
  - Retries and delay were already written as they are.
  - `timeoutValue()` (`core/engine/util.ts`) gives whole seconds for a duration and leaves a
    template as it is. This holds for the module task and for `include_role` `apply`.
  - The template reads the step's inputs. Those are play or block vars, or extra vars for a flow
    input of the same name.
- **Check.**
  - `setting-unknown-var`: a template reads a name that is not an input of the step. It is info
    when a flow input has that name, as `condition-unknown-var` is for Until.
  - `setting-input-type`: the template's only input is a boolean, list, dict or host list.
  - `timeout-unreadable` no longer fires for a template on a step. On an approval it still fires,
    and says AWX needs a fixed duration.
- **Commands.**
  - `NodePatch.inputs` merges step inputs. An @ pick in a Timing field then writes the setting and
    the input it reads in one `updateNode`, so one undo takes both back.
  - `askAtRunTime { id, setting, name, description?, default? }` makes three things in one edit:
    - the integer flow input, or reuses one of that name that can hold a number;
    - the step input `from: flow.<name>`;
    - the template.

    The flow tools get `ask_at_run_time`.
  - Renaming a step input rewrites the Timing templates and Until. Until did not follow a rename
    before.
- **Display.** `timingText(s, result, defaultOf)` shows a template that reads one input with that
  input's default: the step input's, else the flow input's.
  - An expression is "worked out at run time".
  - The total appears only when every part resolves, with "with the defaults" when one came from
    an input.
  - The sentence also says that a try that runs over the timeout ends the step.
- **UI.**
  - `TimingField` wraps `ChipField`, which gained `onEnter`, `onEscape` and `onLeave`. It keeps a
    draft and commits it on Enter or blur, as `CommitField` does.
  - Its @ list (`timingChoices`) offers inputs that can hold a number, never a step's result.
  - "Ask at Run Time…" opens an inline form with the name, what the input is for, and its default.
- **Import.**
  - A templated retries, delay or timeout is kept, no longer dropped.
  - `readsOf` counts the reads in settings and Until, so the importer wires their inputs.

## Consequences

- A value given at run time is checked only at run time: if the operator gives a word where a
  number goes, the task fails. Integer flow inputs are typed in the launch dialog and the AWX
  survey.
- The total-wait pattern needs an expression (`{{ (drain_wait / 10) | int }}`). The sentence shows
  expressions but does not evaluate them.
- A playbook imported with a templated value whose variable it never defines gets
  `setting-unknown-var`, as a parameter would.
