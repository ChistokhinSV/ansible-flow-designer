# Debug a flow

A debug run is a [step-by-step run](step-by-step.md) that also lets you look inside: at each pause
you see the variables of every host, evaluate Jinja expressions, and the run can pause where a
condition holds or where a host fails a step, then run that step again. In VS Code it is VS Code's
own debugger: Call Stack, Variables, Watch, the Debug Console and Breakpoints.

It needs ansible-core 2.19 or later in the run environment. It runs where your other runs run:
local, a container, WSL or an SSH host ([runs and environments](runs-and-environments.md)), not in
AWX. On an older ansible-core the run still pauses, and the Debug Console says why no variables are
shown.

## Start one

- **Run ▾ › Debug…** in the designer's top bar, or **Ansible Flow: Debug Flow…** in the Command
  Palette. The launch dialog opens; its button reads **Debug**. Tick **Pause before the first
  step** to stop at once; otherwise the run goes on to the first pause point or failure.
- Or press F5 with a flow open and no `launch.json`, or add a launch configuration of type
  `ansible-flow` (Run and Debug view › create a launch.json › Ansible Flow):

```json
{
  "type": "ansible-flow",
  "request": "launch",
  "name": "Debug flow",
  "flow": "${file}",
  "mode": "check",
  "stopOnEntry": false,
  "inputs": { "devices": ["edge-rtr-01", "edge-rtr-02"] }
}
```

| Attribute     | Meaning                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------- |
| `flow`        | the `.flow.yaml` to debug                                                                   |
| `mode`        | `check` (check mode, the default) or `real` (asks first, naming the hosts, as Run for Real) |
| `stopOnEntry` | pause before the first step                                                                 |
| `inputs`      | flow input values; the ones left out are asked for. Never put a secret here                 |

A debug run in check mode changes nothing on the hosts, as any check mode run.

## At a pause

Every pause holds all hosts, wherever it comes from.

- **Call Stack** has one thread per host, the host name first: `edge-rtr-07 · failed`,
  `edge-rtr-01 · waiting`, `core-01 · matched`. The pause stops on the first failed or matching
  host. Its frames are the step and the subflows around it, each on its `key:` line in the
  `.flow.yaml`; picking a frame shows that step on the canvas.
- **Variables** shows, for the host of the frame you picked:
  - **Step inputs**: the step's inputs as the run has them;
  - **Host variables**: inventory variables, set_fact values and registered results;
  - **Flow data**: the run's flow inputs;
  - **Facts**: read only when you open it.

  A template is shown as its text, not rendered. A long list or dict loads in pages. A value cut at
  64 KB says so first, with its whole size: `(cut at 64 KB: 70000 characters in all) "xxxx…"`.
- **Masked values** say why, never how long they are: `masked: vault`, `masked: no_log`,
  `masked: credential`, `masked: external secret`, `masked: secret-looking name`. A value that is
  a known secret (a credential's, a secret provider's, a vaulted one) says so, also under a
  secret-looking name. A copy made by a filter (`b64encode`, `to_json`, `~`) is masked too.
- **Debug Console** and **Watch** evaluate a Jinja expression for that host, as you would write it
  in a `when:` (`{{ }}` around it is fine). A lookup, `query`, the `vault` and `unvault` filters
  and names starting with `_` are refused: the console says "Refused: …". An expression stops after
  2 s. Evaluate only reads: it sets nothing and runs no task.
- An expression that reads a masked value is masked whole, with that value's reason, whatever it
  does with it: `password | reverse | join`, `password[0:4]`, `password | length`,
  `password == 'guess'` and `password | hash('sha1')` all read `masked: …`. So does one that
  reads a dict or list with a masked part (`creds | dict2items`), while a plain part of it
  (`creds.user`) is shown. `hostvars[...]` and `vars[...]` count too; with a host or a name
  chosen at run time (`hostvars[inventory_hostname].x`), the value is checked on every host.
- The Debug Console also shows the reason of each pause and the lines log points write.

**Continue** (F5), **Step Over** (F10, runs the step and pauses before the next) and **Stop**
(Shift+F5) work as in a step-by-step run. **Step Into** (F11) does what Step Over does: the run
pauses before the next step, also the first step inside a subflow. Step Out is not there yet; the
Debug Console says so.

## Pause points and breakpoints

A pause point on the canvas is a function breakpoint in VS Code's **Breakpoints** view, named
`<flow key>:<step key path>` (`edge-baseline:push-baseline/apply`), and the other way round: add,
change or remove one in either place. You can also set a breakpoint in the `.flow.yaml` text on a
step's `key:` line; a breakpoint on another line stays hollow and says why.

Right-click a step and choose **Edit Pause Point…** (or edit the breakpoint in VS Code):

- **Always pause**: as a plain pause point.
- **Pause when** a condition: a Jinja condition checked per host before the step. All hosts wait
  when any host matches, and the pause names the hosts that matched. A condition that fails says so
  in the Debug Console and does not pause. A condition that reads a masked value is not checked
  (its true or false would tell the value): the Debug Console says so for each host. In VS Code it
  is the breakpoint's condition.
- **Only after it is reached N times**: counts the hosts arriving at the step (those the
  condition matches, when there is one) and pauses where the count reaches N. In VS Code it is the
  hit count (`3` or `>=3`). Such a pause says "reached 3 times".
- **Log only, never pause**: writes a message per host (Jinja, secrets masked) to the Debug Console,
  the Run panel's **Log points** and the run's output (`Log point <step> · <host>: <message>`).
  Each `{{ }}` of the message that reads a masked value shows `********`, the rest as written. In
  VS Code it is a log point; set on the canvas, it shows in Breakpoints as a function breakpoint
  and keeps its message.

A point with a condition or a count has a dot with a bar; a log point a diamond. Hover over it to
read its settings. These settings work in debug runs; a step-by-step run pauses at the point
always, and passes a log-only point.

## When a host fails

A debug run pauses where a host fails a step (the **Host failed** filter in the Breakpoints view,
on by default) and, if you turn it on, where a host is unreachable (**Host unreachable**). The same
two checkboxes are in **Edit Pause Point…**.

The canvas shows a bar over the flow: "Paused after Apply config: 1 of 4 hosts failed
(attempt 1)", each failed host with its task and message, and:

- **Retry** runs the step again on the failed hosts. The step runs again and changes it made on the
  hosts are not undone. If it fails again, the run pauses again (attempt 2), still with every
  host waiting. In VS Code: the
  **Retry** button in the designer's step bar, or **Ansible Flow: Retry Failed Step**; the
  exception's text says so too.
- **Continue** sends the failed hosts where the flow says (the fail port's wire, or a failed end).
- **Stop** ends the run there, after the step: the failed hosts stay failed at it, and the others
  are stopped after it.

Retry is not offered for a rolling subflow (it runs as one play) or a host that failed outside the
step's rescue; there the bar says why, and **Continue** or **Stop** remain. Run the flow again from
that step as a new run instead.

## Good to know

- The pause points, their settings and the failure filters are kept for this workspace, not in the
  flow file.
- A debug run waits for an answer as long as a step-by-step run (`afd.run.stepTimeout`).
- On Ansible Flow Server's pages the canvas has the same Edit Pause Point… and failure bar.
