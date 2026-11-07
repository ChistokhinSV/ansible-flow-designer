# Retries and polling

Two different needs, set in the **Timing** group of the **Execution** tab of the step's Details.
Each group's fold names what it holds ("Timing: timeout, retries, until, delay · 2 set"); on a
step bound to a module, Timing is open until you close it. Under the fields, one sentence says what
the generated task will do with them, for example "Tries up to 10 times, 15 s apart, until 'ready'
in wait_up_result.stdout; each try at most 30s.

| You want                                                          | Set                                  |
| ----------------------------------------------------------------- | ------------------------------------ |
| try again when the module fails (a flaky API)                     | **Retries**                          |
| ask again and again until a state is reached (a device rebooting) | **Retries**, **Until** and **Delay** |
| the same, from the port menu of `failed_hosts`                    | the **Retry** pattern                |

![Retries, Until and Delay](../images/properties-until-light.png)

## Retries

With only **Retries** set, a module step tries up to that many more times and stops at its first
success: the generated task gets `until: <register> is succeeded`.

## Polling with Until

**Until** is a Jinja test without braces. It reads the step's registered result by its name (the
field's label shows it, default `<key with _>_result`) and the step's inputs. As you type, the field
offers the result's fields from the module's documented returns (`wait_up_result.status`,
`wait_up_result.stdout`, …):

```yaml
settings:
  retries: 40 # tries
  delay: 15 # seconds between tries (Ansible's default is 5)
  until: wait_up_result.status == 200 and wait_up_result.json.version == target_version
```

The step polls for up to `retries × delay` (here 10 minutes). It succeeds when the test holds, and
fails (`failed_hosts`) when it never does.

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

## Retry (pattern)

**Retry** on `failed_hosts` (or `timeout`) sets **Retries** 3 and **Delay** 10 s on the step
itself, keeping any value it has already: the generated task tries again, so the flow does what
the code does. Hosts that still fail after the last try leave by the same port, which stays open
until you handle it. It adds no node. Ansible retries a module task only, so the pattern is not
offered on a role, a playbook, a subflow or `unreachable`. Flows from before 0.31 may hold a
"Retry …" step with purpose `retry`; it is a step like any other.
