# Tutorial 1: your first flow

**Goal:** design an "NTP baseline" flow for switches and see the playbook it makes after two
steps. Then decide what happens when a step fails, and run the flow as a skeleton.

**Time:** 10 minutes. **You need:** VS Code with the extension and a folder open (an empty one is
fine). Designing needs no Ansible. Only the last step, the skeleton run, needs an Ansible
environment, and the extension helps you set one up.

> Just want to look first? **Open Sample Flow…** → **Hello, Ansible**: three steps that already run.

## 1. Create the flow

1. Click the **Ansible Flows** icon in the Activity Bar → **New Flow**. Or, in the Command Palette
   (Ctrl+Shift+P), run **Ansible Flow: New Flow…**.
2. Name it `NTP baseline`.

The extension creates `flows/ntp-baseline/ntp-baseline.flow.yaml` and opens it in the designer. A
new flow has a **Start** and a **Done** node, and one flow input, `devices`: the hosts it runs on.

![A new flow: Start wired to Done](../images/new-flow-light.png)

## 2. Add two steps

1. On the card under the nodes, click **Add a Step**. Type `Check NTP` and press Enter. The step
   goes between Start and Done.
2. With **Check NTP** still selected, press **N**, type `Push NTP servers` and press Enter. It goes
   after Check NTP, before Done.

![Quick Add inserting a task on the wire](../images/quick-add-light.png)

Hosts travel along wires: the hosts **Check NTP** succeeds on leave by its `ok_hosts` port and
arrive at the next step. Give each step an **intent** in its Details if you like: one sentence on
what it does. The skeleton run prints it.

A **Your first flow** checklist now shows at the bottom left. It ticks off what this tutorial does.

## 3. See the playbook

Save (Ctrl+S). Saving writes `generated/ntp-baseline.yml` next to the flow, **one play per
step**. Select **Check NTP** and click **Peek Code** (`</>` in its Details) to see its play. It has
no code of its own yet, so it prints `TODO`. That is what makes the flow runnable already: a
walking skeleton.

> Do not edit files in `generated/`: they are rewritten from the flow. See
> [generated code](../how-to/code-generation.md).

## 4. Decide what happens when a step fails

Each step also has a `failed_hosts` port, for the hosts it failed on. An **amber** port is a
failure nothing handles yet, and the banner asks about it:

![The banner asks what should happen when a step fails](../images/open-ports-banner-light.png)

| Step             | Choose                      | Why                                                   |
| ---------------- | --------------------------- | ----------------------------------------------------- |
| Check NTP        | **Exclude and Report**      | a read-only check: take those hosts out and list them |
| Push NTP servers | **Notify On-Call and Stop** | the change failed: someone must look                  |

Click the choice on the banner (or click the amber port for all of them). Each one adds a handler
and an end node in **one undo step** (Ctrl+Z). To keep a port open on purpose instead, choose
**Accept with Reason…**: the flow records your reason and your Git user name. More in
[ports and failure patterns](../how-to/ports-and-failure-patterns.md).

![The port menu of an open failed_hosts port](../images/port-menu-light.png)

## 5. Run it as a skeleton

1. Click **Run as Skeleton** in the top bar.
2. Press Enter on `localhost`, the hosts it suggests.

The extension runs `ansible-playbook --check` in your Ansible environment, in a terminal. When it
finishes, the top bar shows the hosts, failures and exit code. Switch to **Run**: every wire shows
how many hosts took it.

![Run mode after a skeleton run](../images/run-mode-light.png)

No Ansible environment yet? The run says so and offers **Set Up Ansible Environment…**: with
Docker or Podman it uses a public image that has Ansible, and the first run downloads it. See
[runs and environments](../how-to/runs-and-environments.md).

## What you learned

- A flow is a diagram in a YAML file, and each step becomes a play in a generated playbook.
- Hosts travel along wires from port to port; every fail port needs a handler or a reason.
- A skeleton run works before any step has code.

**Next:** [how flows work](../explanation/how-flows-work.md) explains what happens to the hosts,
and [Tutorial 2](02-design-to-production.md) groups steps into subflows and binds them to real
modules.
