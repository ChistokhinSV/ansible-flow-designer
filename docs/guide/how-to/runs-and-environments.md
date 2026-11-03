# Runs and environments

Designing needs no Ansible. Runs, syntax checks, the module catalog and Code mode need an
**Ansible environment** with ansible-core 2.19 or later.

## Choose an environment

The quickest way: **Set Up Ansible Environment…** (Command Palette, or the button on the error a
run shows when it has nowhere to run). It looks for Docker and Podman and proposes the public
Ansible dev tools image, `ghcr.io/ansible/community-ansible-dev-tools:latest` (ansible-core 2.21
at the time of writing; replace it with your organisation's image if you have one). The first run
pulls it, which takes a few minutes. On Windows with the WSL extension it can also reopen the
folder in WSL instead, where you install Ansible yourself (`pipx install ansible-core`). Or set it
by hand:

| You have                                                              | Set                                                                                                  |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Docker or Podman (the only option on native Windows)                  | `afd.environment.image` = an execution environment image, e.g. `registry.example.net/ee/netops:2.19` |
| VS Code Remote (WSL, SSH, Dev Container) with Ansible installed there | nothing: local mode runs inside the remote                                                           |
| a local venv with Ansible                                             | `afd.environment.python` = its interpreter, or leave it to `ansible.python.interpreterPath`          |

`afd.environment.kind` is `auto`: `container` when an image is set, else `local`. With the Red Hat
Ansible extension enabled, its execution environment image and container engine are used when ours
are empty. `afd.environment.containerOptions` adds `docker run` arguments, e.g. to mount your SSH
keys: `["-v", "/home/jane/.ssh:/home/ansible/.ssh:ro"]`.

The extension talks to the environment through a small Python helper that uses only the standard
library, so any image with ansible-core works.

## Run as Skeleton

**Run as Skeleton** (top bar, or the play button in the editor title bar):
1. generates the code;
2. asks for the flow inputs (remembered per flow; host lists are hosts or groups, comma-separated;
   the first skeleton run suggests `localhost`);
3. runs `ansible-playbook --check` in a terminal, in your environment.

Unbound steps print `TODO: <intent>`. Bound modules run in check mode; the catalog badges say which
modules support it.

## Run for real

**Run for Real…** (under the arrow of _Run as Skeleton_) first shows a confirmation with:
- the inventory (`afd.run.inventory`, else `ansible.cfg`'s default);
- how many hosts match the targets, and hosts missing from the inventory;
- groups whose names look like production.

The vault password is asked per run when the inventory or repository vars contain vault data
(`afd.run.askVaultPassword`). It is passed through an environment variable, never stored or logged.
Secret-looking inputs (names with password, secret, token, key or vault) are typed hidden, travel
the same way and are never remembered. Other input values are written for the run only and deleted
when it ends.

## After a run

- While a run goes, **Stop** in the top bar (or **Ansible Flow: Stop Run**) ends it; the run shows as
  stopped, not failed.
- The top bar shows hosts, failures and the exit code; **Show terminal** brings the output back.
- Switch to **Run**: nodes show "3 hosts · 1 failed · 2.1 s", wires show how many hosts took them.
  Select a node or a wire to list the hosts and why they failed. With nothing selected, the panel
  lists the **Failed steps** of every level; click one to open it where it is.
- Every launch goes to a local audit log (**Ansible Flow: Show Run Audit Log**): who, when, which
  flow version, which targets, without input values. It rotates at 1 MB and keeps two older files;
  each flow keeps the event logs of its last 30 runs (`afd.runs.keep`).
- Runs need a trusted workspace: in Restricted Mode you can design and generate, but not run
  ([settings](../reference/settings.md#restricted-mode)).
- After a passing real run of the current flow version, the run panel offers **Mark N nodes
  tested**.

![Run mode](../images/run-mode-light.png)

## Approvals in local runs

Approvals approve by themselves in local runs. To try another path, run the generated playbook from
a terminal with `afd_approvals` ([approvals](approvals.md)).

## Syntax check

**Ansible Flow: Check Flow** runs `ansible-playbook --syntax-check` in the
environment and puts errors on the generated files in the Problems panel.
