# Runs and environments

Designing needs no Ansible. Runs, syntax checks, the module catalog and Code mode need an
**Ansible environment** with ansible-core 2.19 or later.

## Choose an environment

The quickest way: **Set Up Ansible Environment…** (Command Palette, or the button on the error a
run shows when it has nowhere to run). It looks for Docker and Podman and proposes the public
Ansible dev tools image, `ghcr.io/ansible/community-ansible-dev-tools:latest` (ansible-core 2.21
at the time of writing; replace it with your organisation's image if you have one). The first run
pulls it, which takes a few minutes. On Windows it also lists your WSL distributions: Ansible then
runs inside the one you pick, from Windows VS Code, and you install it there yourself
(`pipx install ansible-core`). Or set it by hand:

| You have                                                                 | Set                                                                                                                             |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Docker or Podman                                                         | `afd.environment.image` = an execution environment image, e.g. `registry.example.net/ee/netops:2.19`                            |
| a WSL distribution on Windows with Ansible installed in it               | `afd.environment.kind` = `wsl`, and `afd.environment.wslDistro` = its name (empty: WSL's default)                               |
| a remote Linux host you reach with `ssh`, the repository on this machine | `afd.environment.kind` = `ssh`, and `afd.environment.sshHost` = the host ([A remote Linux host](#a-remote-linux-host-over-ssh)) |
| VS Code Remote (WSL, SSH, Dev Container) with Ansible installed there    | nothing: local mode runs inside the remote                                                                                      |
| a local venv with Ansible                                                | `afd.environment.python` = its interpreter, or leave it to `ansible.python.interpreterPath`                                     |

`afd.environment.kind` is `auto`: `container` when an image is set, else `local`. With the Red Hat
Ansible extension enabled, its execution environment image and container engine are used when ours
are empty. `afd.environment.containerOptions` adds `docker run` arguments, e.g. to mount your SSH
keys: `["-v", "/home/jane/.ssh:/home/ansible/.ssh:ro"]`.

**WSL:** the distribution sees your drives under `/mnt` (`C:\repo` is `/mnt/c/repo`), so the
repository stays on Windows. WSL 1 and WSL 2 both work. Install Ansible there as on Linux, e.g.
`pipx install ansible-core`, and the collections your flows use (`ansible-galaxy collection
install cisco.ios`): an image brings them, a distribution does not. The extension uses the PATH of
a login shell (so `~/.local/bin` counts) and the Python on the first line of `ansible-playbook`,
so a pipx venv needs no setting (`afd.environment.python` overrides it). Name the distribution:
with Docker Desktop, WSL's default may be `docker-desktop`, which has no Ansible.

Runs on `/mnt` are slower than on Linux disks. SSH keys and `~/.ansible` come from your home folder
in the distribution, not from Windows: keep keys there with `chmod 600`, as ssh refuses a key under
`/mnt/c`, which looks readable to everyone. For the same reason Ansible would ignore the
repository's `ansible.cfg`; the extension names it explicitly, as it does for containers. WSL 1
shares the network of Windows: an antivirus that inspects HTTPS breaks downloads in WSL 1 (apt,
`ansible-galaxy`, `get_url`) until the distribution trusts the antivirus's root certificate. WSL 2
is not affected.

The extension talks to the environment through a small Python helper that uses only the standard
library, so any image with ansible-core works.

### Switch between environments

Once more than one is set up (an image for this machine, a WSL distribution, an SSH host), **Switch
Ansible Environment…** goes from one to another in one click: the first button on the **Inventory**
view's title, **Change** beside "Runs in" in the launch dialog, or the Command Palette. It lists
the environments your settings describe and the WSL distributions of this machine, with the one in
use marked, and **Set Up Another…** for anything else. A switch writes `afd.environment.kind` in
the workspace settings and asks nothing: the host, the distribution and the images stay as they
are, so you can switch back.

### A remote Linux host over SSH

A shared host can run your flows while the repository stays on your machine: a jump host, an
operations server, the place your team already runs Ansible from. **Set Up Ansible Environment…**
offers **A Remote Linux Host over SSH**: it lists the hosts of your SSH config, connects, looks at
what the host has, and writes the settings of this workspace (an SSH host is per workspace; the
other choices write your user settings, unless the workspace already sets an environment). A host
with Ansible on its PATH runs that, also when your user settings name an image: the image on the
host is a setting of its own. By hand:

| Setting                           | Value                                                                                           |
| --------------------------------- | ----------------------------------------------------------------------------------------------- |
| `afd.environment.kind`            | `ssh`                                                                                           |
| `afd.environment.sshHost`         | a `Host` of your `~/.ssh/config`, or `user@host`                                                |
| `afd.environment.sshDir`          | the folder there for this workspace; empty is `~/.afd/<workspace folder name>`                  |
| `afd.environment.sshImage`        | empty: the `ansible-playbook` on the account's PATH runs. Set: Ansible runs in this image there |
| `afd.environment.containerEngine` | with an image: `docker` (default) or `podman`, the host's                                       |
- **The connection is yours.** The extension runs your `ssh` with your config, keys and agent. It
  never asks for a password and never stores one: the host must connect from a terminal with
  `ssh <host>` without a question. Host keys are checked as your config says.
- **What runs is what you have now.** Before a run, and before the probe answers (lenses, the
  module catalog, the launch dialog's host counts), the repository is copied to the host: the
  files Git tracks and the untracked ones no `.gitignore` names, as they are on disk, so
  uncommitted work runs. After the first copy only changed files travel, and files you deleted
  are deleted there. `.git` is not copied. A run of part of a flow copies its `.afd-run` folder
  too.
- **Ansible on the host:** either its own (`pipx install ansible-core`, 2.19 or later, on the PATH
  of a login shell, with the collections your flows use), or an execution environment image with
  the host's Docker or Podman. An image runs as it does on your machine: the copy mounted
  read-only at `/work`.
- **The folder on the host** (`afd.environment.sshDir`) holds the copy (`repo/`), the helper
  (`probe/`), the runs (`runs/`), the catalog's dumps (`cache/`) and files you copied (`files/`).
  It is made readable by the account alone. On an account several people share, two people with
  the same folder overwrite each other's copy: give each person, or each purpose (testing,
  production), a folder of its own.
- **Secrets:** a vault password and secret inputs go to the host on the connection's input, never
  as command arguments, into files only the account reads, removed when the run ends. Other
  inputs are written to the run's folder there and removed with it.
- **A vault password file, a key an inventory script needs:** a run finds on the host only what is
  in the repository. **Ansible Flow: Copy a File to the SSH Host…** copies one file of this
  machine there, readable by the account alone, to a path you choose (it proposes the `files/`
  folder); name that path where it is used, for example `vault_password_file` in `ansible.cfg`.
  Typing the vault password at each run, as with every other environment, needs no file.
- **While it runs** the canvas shows the run as it goes, and **Stop Run** ends it on the host.
- **Limits:**
  - This machine needs OpenSSH's `ssh` and `tar` on its PATH: Windows 10 (1803) or later has
    both; older Windows does not.
  - The host needs `tar`, `base64` and a POSIX `sh`.
  - Files copied from Windows have no executable bit of their own: the ones Git marks executable
    are made executable there, the rest are not. Line endings travel as they are on disk.
  - Paths outside the repository (an inventory elsewhere on this machine) are not copied.
  - The command-line scenario runner (`afd-scenarios`) has no SSH option; scenarios verified from
    the designer do run on the host.

## Run as Skeleton

**Run as Skeleton** in the designer (top bar, or Ctrl+F5) opens the **launch dialog**:
- every flow input, by name and type, with what it was last time (remembered per flow) or its
  default. A first skeleton run suggests `localhost` for the hosts, or, when the inventory has
  groups, starts empty so you pick one. An input's description, when the flow has one, says what
  it is for. In the flow panel, each input has its description and a **Default** (read by its
  type: text, a whole number, true or false, a list with commas). A new input starts as required;
  giving it a default makes it optional, since the default then fills it;
- host lists take hosts or groups, comma-separated; the inventory's groups are buttons under the
  field, each with its number of hosts ("lab · 4") and their names in the tooltip. Lists take items separated by commas (`10.20.0.10, 10.20.0.11`) or a JSON list, and the
  dialog says what the field reads as ("2 items: …"). Dicts take `key: value` lines or JSON;
- the hosts the targets match in the inventory, counted again as you change them, even before
  the other inputs are filled in;
- **Run as Skeleton**, which generates the code and runs `ansible-playbook --check` in your
  environment. Escape or Cancel closes the dialog.

From the Command Palette (**Ansible Flow: Run as Skeleton**), or with no designer open, the run
asks for each input in an input box instead.

### Run part of a flow

Right-click a step of the top level:

- **Run from Here (Skeleton)** starts the hosts at that step and runs the rest of the flow.
- **Run This Step (Skeleton)** runs that step alone, then ends.

Both are skeleton runs (check mode), with the inputs remembered from the last run or asked for in
input boxes. The steps before the one you chose do not run, so what they would have made is not
there: a bound step that reads one of them runs as its TODO stub instead, and the Run panel says
which steps those were. This is why a part of a flow cannot be run for real.

The run uses a trimmed copy of the flow, generated into a folder `.afd-run` beside `generated/`
for the time of the run and removed after it; the flow's own generated code is not touched. The
folder ignores itself in Git.

## While a run goes

- **The canvas follows it.** A run started from the designer switches it to **Run** mode. The step
  that runs now has a pulsing outline and reads "running…"; a subflow does too while a step inside
  it runs. Steps that are done show their hosts as they finish, about every half second, and steps
  not reached yet read "waiting". The top bar says which step runs.
- **The terminal stays out of the way** while the flow's designer is open: the run's output goes
  to its own terminal, which is not brought forward.
  - It shows by itself when the canvas cannot explain the run: the run did not start, produced no
    events, or failed before its first step (an inventory or syntax error).
  - **Show Terminal** (top bar, run panel) brings forward that run's terminal, not just the last
    one. With no designer open, the terminal shows as before.
- **No new events for 20 s:** a notification and the top bar say so, with **Show Terminal**. A
  step may be slow, or the run may be waiting for input there (an SSH host key question, a
  `pause`).

Unbound steps print `TODO: <intent>`. Bound modules run in check mode; the catalog badges say which
modules support it.

## The Flows view

**Flows**, in the **Ansible Flows** view of the Activity Bar (or **Flows View** in a flow's panel,
under the Readiness counts, which says what the workspace's flows need: "In this workspace: 1 flow
with errors, 1 with code edited by hand"; when a flow needs a look, the line shows at the top of
the panel too), lists the repository's flows by folder (a folder that only holds its own flow is not a level of its own). Each flow says what needs
a look:

- its errors and warnings, which the Problems panel lists too, open or not;
- **code out of date**: its generated playbooks do not match the flow yet, and a save writes them;
- **code edited by hand**: a generated playbook was changed in an editor, so a save leaves it alone
  (Generate Code asks before it writes over the change);
- **no code yet**.

The tooltip explains the state. **Run as Skeleton** (the play button on a flow) opens it with its
launch dialog. **Peek Code** opens its generated playbook.

## The Inventory view

The **Problems** panel lists every flow's errors and warnings, read in the background after
start-up (`afd.problems.scope: open` for open flows only). An open flow also gets the checks that
need the module catalog, so it can list more. A generated playbook edited by hand gets a warning
there, with **Open the Flow**.

**Inventory**, in the **Ansible Flows** view of the Activity Bar, lists the inventory the runs use
(`afd.run.inventory`, else `ansible.cfg`'s), read in your Ansible environment. Each group shows its
host count and opens into its child groups and its hosts. **Run Flow on This Group…** (the play
button on a group or a host) opens the launch dialog of the flow you are working on, with that group
as its targets.

The view and the inventory's files stay together:

- **Click a host**, or use **Open in Editor** on a host or a group, to go to the line it is written
  on. A host that is one of a range (`sw[01:10]`) opens at the range.
- **Sources**, at the top, lists the files the inventory is read from and what each is: YAML or INI
  (static: the hosts are written there), or dynamic (an inventory plugin's configuration, a script:
  the hosts come from elsewhere, so they have no line to open). A folder inventory shows the files
  Ansible reads from it; as Ansible does, it skips `.ini` and `.cfg` files there.
- **Saving** an inventory file, a file under `group_vars/` or `host_vars/`, or `ansible.cfg` reads
  the view again. **Refresh Inventory** does it by hand, for a dynamic source that changed.
- **New Inventory…** (the view's `…` menu, or the link shown when there are no hosts) creates a YAML
  inventory with no hosts yet, makes it this workspace's inventory and opens it.

The view's title line says which inventory it shows and in which environment. Two buttons there
change them:

- **Switch Ansible Environment…**: see [Switch between environments](#switch-between-environments).
- **Switch Inventory…** lists the inventories found in the repository (a `hosts` or `inventory`
  file at the root, the `inventory/` folder and its files, one folder or file for each environment
  under `inventories/`), **The Default of ansible.cfg**, and **Browse…** for one kept elsewhere in
  the repository. The pick is this workspace's `afd.run.inventory`: runs, the launch dialog and the
  Inventory lens use it from then on.

The launch dialog shows both too ("Runs in: … · Inventory: …"), each with **Change**.

## Run for real

**Run for Real…** (under the arrow of _Run as Skeleton_) opens the same dialog. It also says, in
words, what the run touches:
- the inventory (`afd.run.inventory`, else `ansible.cfg`'s default);
- how many hosts match the targets, and hosts missing from the inventory;
- groups whose names look like production.

**Run for Real** in the dialog runs with no further question. Just before it starts, the run
counts the hosts again: when the inventory answers differently from what the dialog showed, nothing
runs, and the dialog opens again with the new facts. From the Command Palette the same facts come
as a confirmation.

The vault password is asked per run (in the dialog, a field) when the inventory or repository vars contain vault data
(`afd.run.askVaultPassword`). It is passed through an environment variable, never stored or logged.
Secret-looking inputs (names with password, secret, token, key or vault) are typed hidden, travel
the same way and are never remembered. Other input values are written for the run only and deleted
when it ends.

Inside the environment, the password and the secret inputs go into owner-only temporary files that
are removed however the run ends, Stop included. Their variables are unset before
`ansible-playbook` starts, so tasks, inventory scripts and `lookup('env')` never see them. The
run's events (what the canvas and **Show output** read) never contain their values: a list or dict
secret is hidden by its parts too.

A run adds Ansible Flow's event callback to the `callbacks_enabled` and `callback_plugins` of your
`ansible.cfg`, so your own callbacks (ARA, syslog, audit) keep recording runs started here.

SSH host keys are checked, as Ansible does by default; the `afd-ee` image no longer turns that
off. Give the environment your `known_hosts` (a mount in `afd.environment.containerOptions`), or,
for a lab only, set `host_key_checking = False` in the lab repository's `ansible.cfg`.

## After a run

- While a run goes, the Run button is **Stop** (or **Ansible Flow: Stop Run**, Shift+F5): it ends
  the run, which shows as stopped, not failed.
- The top bar shows hosts, failures and the exit code; **Show terminal** brings the output back.
- In **Run** mode, nodes show "3 hosts · 1 failed · 2.1 s", wires show how many hosts took them.
  Select a node or a wire to list the hosts and why they failed. For a local run, **Output** on a
  host's row shows what each task of that step printed for it: `msg`, `stdout` and `stderr` (up to
  2000 characters each), changed and the return code. A `no_log` task shows only that its output
  is hidden. Secret inputs never appear: their values are replaced in the run's kept events. With nothing selected, the panel
  lists the **Failed steps** of every level; click one to open it where it is, and **‹ Run
  Results** at the top of its Details brings the list back.
- Every launch goes to a local audit log (**Ansible Flow: Show Run Audit Log**): who, when, which
  flow version, which targets, without input values. It rotates at 1 MB and keeps two older files;
  each flow keeps the event logs of its last 30 runs (`afd.runs.keep`).
- **Earlier runs:** the Run panel lists the local runs kept of the flow, the newest first, each
  with its time, kind and result. Choose one and the canvas shows it again: where each host went,
  the failed steps, each host's output. A run of an earlier version of the flow says so, since
  steps may have changed. Runs made before this list existed, and AWX runs, are not in it.
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
