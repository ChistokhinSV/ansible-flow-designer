# Run step by step

A step-by-step run pauses before each step of the flow. You see on the canvas where it waits and
which hosts wait there, what the steps before did to each host, and you decide: run the next step,
run on, or stop. Use it to try a new flow carefully, or to show what a flow does one step at a
time.

It runs where your other runs run: in the local environment, a container, WSL or an SSH host
([runs and environments](runs-and-environments.md)). It does not run in AWX: AWX starts Ansible
itself, with no way to pause it from here.

## Start one

- **Run ▾ › Run Step by Step…** in the designer's top bar, or **Ansible Flow: Run Step by Step…**
  in the Command Palette. The launch dialog opens with **Step by step: pause before each step**
  ticked; fill the inputs and press **Run**.
- The tick is also in the dialog that **Run** (Ctrl+F5) and **Run for Real…** open: a real run can
  go step by step too.

The run starts and pauses before its first step. The canvas switches to **Run** mode.

## While it waits

- The step the run waits before has a ring and a badge with the number of hosts waiting there. A
  subflow on the level you look at has them when the step is inside it. Its line reads "paused
  here · 3 hosts waiting".
- The steps already run show what they did, as in any run: hosts, failures, output. Steps not
  reached yet read "not reached yet".
- The top bar reads "Paused before Ping · 1 host"; click it to show that step. The Run panel says
  the same, which hosts wait, and when the run stops by itself.

## Step, Continue, Pause, Stop

| Button   | Key      | What it does                                                                                  |
| -------- | -------- | --------------------------------------------------------------------------------------------- |
| Step     | F10      | Runs the step it waits before, then pauses before the next one                                |
| Continue | F5       | Runs on, and pauses only before a pause point; with none, runs to the end                     |
| Pause    | F6       | While a step runs: pauses before the next step                                                |
| Stop     | Shift+F5 | While paused: ends the run there; while a step runs: ends the run now, as Stop Run always did |

The buttons are in the top bar beside **Stop** and in the Run panel; the keys work while the
flow's designer has focus. A run stopped while it waits ends as **stopped**, not failed: its hosts
read "stopped before <step>" in the Run panel and the step reads "stopped before · 3 hosts".

A step runs on all its hosts together. Steps no host reaches are not paused at. A subflow pauses at
each step inside it, not at the subflow itself.

## Pause points

Right-click a step and choose **Add Pause Point**: a red dot marks it. **Continue** runs on to the
next pause point. Pause points are kept for this workspace, not in the flow file, so they do not
show up in a commit. **Remove Pause Point** takes one away; a change applies to the run going from
its next step on.

## When nobody answers

A paused run waits for an hour, then stops by itself, also when VS Code was closed in the
meantime. The Run panel then says "Stopped before <step>: nobody answered for 60 minutes".
Change the time with `afd.run.stepTimeout` (seconds).

## Good to know

- A step-by-step run runs Ansible's `linear` strategy, whatever `strategy` the repository's
  `ansible.cfg` sets (`free`, Mitogen): its steps must keep their hosts together. The repository's
  own strategy plugin folders stay found.
- Approvals approve by themselves in local runs, as in any local run.
- Each answer takes a tenth of a second to reach the run; over SSH about half a second.
- A paused run holds its `ansible-playbook` process: little CPU, the memory of one Ansible run.
