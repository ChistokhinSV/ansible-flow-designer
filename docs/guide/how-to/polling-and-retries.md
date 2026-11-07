# Retries and polling

Two different needs, set in the **Timing** group of the **Execution** tab of the step's Details.
Each group's fold names what it holds ("Timing: timeout, retries, until, delay · 2 set"); on a
step bound to a module, Timing is open until you close it. Under the fields, one sentence says what
the generated task will do with them, for example "Tries up to 11 times (once, then 10 retries),
15 s apart, until 'ready' in wait_up_result.stdout; each try at most 30s; the step takes at most
8 min in all." Ansible runs a task once, then retries it, so Retries 10 makes 11 tries.

| You want                                                          | Set                                  |
| ----------------------------------------------------------------- | ------------------------------------ |
| try again when the module fails (a flaky API)                     | **Retries**                          |
| ask again and again until a state is reached (a device rebooting) | **Retries**, **Until** and **Delay** |
| the same, from the port menu of `failed_hosts`                    | the **Retry** pattern                |

![Retries, Until and Delay](../images/properties-until-light.png)

## Retries

With only **Retries** set, a module step runs once, then tries again up to that many more times and
stops at its first success: the generated task gets `until: <register> is succeeded`. Retries 3
makes up to 4 tries. With Until and no Retries, Ansible retries 3 times.

## Polling with Until

**Until** is a Jinja test without braces. It reads the step's registered result by its name (the
field's label shows it, default `<key with _>_result`) and the step's inputs. As you type, the field
offers the result's fields from the module's documented returns (`wait_up_result.status`,
`wait_up_result.stdout`, …):

```yaml
settings:
  retries: 40 # tries again up to 40 times after the first: 41 tries
  delay: 15 # seconds between tries (Ansible's default is 5); the field takes 15s or 1m too
  until: wait_up_result.status == 200 and wait_up_result.json.version == target_version
```

The step polls for about `retries × delay` (here 10 minutes), plus the time each try takes; with a
Timeout, the Timing sentence gives the longest it can take in all: (retries + 1) × timeout +
retries × delay. It succeeds when the test holds, and fails (`failed_hosts`) when it never does.

- `target_version` here is an input of the step (`from: flow.target_version`). The validator
  checks every name in Until (`condition-unknown-var`).
- Test a **field** of the result, not the whole result: `wait_up_result == "ready"` compares a dict
  with a string and never holds, so the step polls to the end every time. The validator warns
  (`until-whole-result`); `'ready' in wait_up_result.stdout` is what was meant.
- Until applies to **module** steps. On a role or a playbook it is ignored, with a warning
  (`until-not-module`): put the polling in its own module step.
- A failed attempt, such as connection refused during a reboot, counts as "not yet": the step
  keeps polling.
- **Timeout** (Execution tab) limits one attempt, not the time between attempts (that is
  **Delay**). Write it as `30s`, `15m` or `1h30m`: the field refuses anything else, and a timeout
  written otherwise in the file is left out of the task, with a warning (`timeout-unreadable`). With
  the optional `timeout` port enabled, hosts that time out leave through it.
- A try that runs over its Timeout ends the step: Ansible makes no more tries after it.

## A wait the operator sets at run time

Retries, Delay and Timeout take a number, or a value given when the flow runs. Whoever starts the
flow then sets the wait in the launch dialog or the AWX survey, and the step's default is the flow
input's default.

- **Ask at Run Time…** under a Timing field makes three things in one edit:
  - an integer flow input, whose default is the field's value (Delay and Timeout in seconds);
  - an input of the step that reads it;
  - the field's new value, which reads that input.

  One undo takes all three back. The field then says "Asked at run time: the flow input
  drain_tries, default 12".
- **@** in the field offers the step's inputs and the flow inputs that can hold a number. Picking
  a flow input adds the step input too, in the same edit. Delay and Timeout read whole seconds.
- The Timing sentence reads with the defaults: "Tries up to drain_tries + 1 times (13 with its
  default 12), 10 s apart, until …; the step takes at most 8 min 30 s in all with the defaults".

For a total wait, such as "300 seconds unless the operator gives another number", work Retries out
from a flow input of seconds:

1. Make a flow input `drain_wait` (default 300), and a step input `drain_wait` with
   `from: flow.drain_wait`.
2. Set Delay to `10`.
3. Type `{{ (drain_wait / 10) | int }}` in the Retries field.

The sentence says the expression is worked out at run time.

```yaml
settings:
  retries: "{{ (drain_wait / 10) | int }}" # 300 s of waiting at 10 s apart: 30 retries
  delay: 10
  timeout: "{{ drain_limit }}" # whole seconds, from a step input
```

The check flags two mistakes:
- a template reading something that is not an input of the step (`setting-unknown-var`);
- an input that holds no number, such as a list (`setting-input-type`).

An approval's timeout stays a duration, because its AWX template needs a number when the workflow
is built (`timeout-unreadable`).

## Retry (pattern)

**Retry** on `failed_hosts` (or `timeout`) sets **Retries** 3 and **Delay** 10 s on the step
itself, keeping any value it has already: the generated task tries again, so the flow does what
the code does. Hosts that still fail after the last try leave by the same port, which stays open
until you handle it. It adds no node. Ansible retries a module task only, so the pattern is not
offered on a role, a playbook, a subflow or `unreachable`. Flows from before 0.31 may hold a
"Retry …" step with purpose `retry`; it is a step like any other.
