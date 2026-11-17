# Ansible Flow Server

Run flows on [Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server), your
team's server for flows, and follow them on the canvas. The server runs flows from its projects
(git repositories), with launch configurations, access levels, approvals and an audit log; this
page is about running one from VS Code.

## Connect

**Connect to Ansible Flow Server** is a button of the **Flows** pane: in its title, and among the
first buttons of a folder without flows. It asks three things and keeps them for the folder:

1. **The address**, as in the browser (`https://flows.example.net:8443`). It is checked against the
   server first. A lab server with a self-signed certificate offers to turn verification off.
2. **An access token** (**My account → Access tokens** on the server). It is checked and kept in VS
   Code's SecretStorage only; a token already kept for that address is used again.
3. **The project** this folder is a copy of: found from the git remote when the folder was cloned
   from the server, else picked from the server's workspaces (or **No project now**).
   - **A folder without flows** then offers to **get the project's flows**: the folder becomes a
     git copy of the project (its branch checked out, the server's git address as `origin`). Change
     the flows here and push to send them back; git asks for a password when it pulls or pushes:
     an access token. A connected folder without flows has **Get the Project's Flows** in the pane.
   - **A folder with flows of its own** also offers **New Project from This Folder…**: a workspace,
     a key and a name, then a project made on the server and the folder's history sent to it. A
     folder that is not a git repository is made one first, with all its files in one commit
     (asked first). Making a project needs `rw` on the workspace.

Picking an existing project for a folder that has flows of its own warns first: linking copies
nothing either way, so it offers **New Project from This Folder…** instead, or **Link Anyway**.

### Which flows are the server's

Once connected, each flow in the **Flows** pane says how it stands with the server project (at the
project's commit):

| Mark            | Means                                                    |
| --------------- | -------------------------------------------------------- |
| on server       | the server has it as it is here                          |
| changed here    | changed in this folder and not sent yet: commit and push |
| newer on server | the server has a newer version: pull                     |
| only here       | the project does not have it: commit and push to add it  |

Flows of the project that the folder does not have are listed under **On the server, not here**,
and a note above the flows says when the server has commits this folder has not pulled. The marks
are read again when flows change, when VS Code gets the focus back, and on **Refresh**.

### Commit, push and pull from the Flows pane

The **Flows** pane's title has **Pull** and **Commit & Push…** (in a git repository). Commit & Push
saves open flows, asks for a message, commits every change of the folder and pushes the branch;
Pull brings the branch's new commits, puts this folder's own commits on top and keeps changes that
are not committed. Right-click a flow for **Commit & Push This Flow…** (the flow, its generated
playbook and its scenarios only), **Duplicate Flow…** (a copy beside it with its own id and key) and
**Delete Flow** (those files to the trash).

When the remote is the connected server's git address, git gets the connection's token and its
certificate setting for that call only: nothing is written to the repository, and a lab server
with a self-signed certificate works without changing git's settings. Another remote uses git's own
sign-in. **Update** and **Show changes** on the canvas pull the same way.

### Git outside the designer: Set Up Git for the Server

Source Control and git in the terminal do not get the designer's settings, so against a server with
a self-signed certificate they fail with "certificate … not trusted" (`SEC_E_UNTRUSTED_ROOT` on
Windows). **Set Up Git for the Server…** (the server button's menu, the Command Palette, or the
button on such an error) fixes that for the folder's repository:

1. It shows the server's certificate (subject, issuer, expiry, SHA-256). Compare the fingerprint
   with the server's **Server certificate** page, then choose **Trust for Git**.
2. The certificate is kept in the repository's `.git` folder and git trusts it for the server's
   address only (`http.<address>/.sslCAInfo`; on Windows also `.sslBackend openssl`, since
   Windows' own certificate check reads no file). Other remotes and repositories are not changed.
3. With a credential helper (on Windows, the Credential Manager), **Let Git Sign In** gives git your
   token as the password for the server's address, so pulls and pushes do not ask. Remove it there
   to take it back.

When the server gets a new certificate, run it again.

You are asked this yourself when it matters: after **Connect**, after **Get the Project's Flows**,
and for the new folder of **Change Project**, the designer checks whether git in the repository
trusts the server; if it refuses the certificate, the same question comes at once.

### A folder that holds several projects

The server, **Pull**, **Commit & Push** and git's trust work per workspace folder, and a folder's
server settings are in its own `.vscode/settings.json`. A folder opened above its repositories (two
clones in one downloads folder) is not a repository itself, so none of that works there. The
**Flows** pane says which repositories of flows it holds, and **Open Repositories as Workspace
Folders…** (the folder button on the pane, or the Command Palette) puts them in the workspace in its
place: each then has its server, pull and push, as in any multi-root workspace. VS Code makes an
untitled workspace of them; **File › Save Workspace As…** keeps it.

Once connected, the pane names the server and the project, and its title has a server button with
**Open in Browser**, **Change Project**, **Set Up Git for the Server…**, **Connect to a Different
Server** and **Disconnect**
(which forgets the token and the folder's settings; flows and runs stay).

The same by hand:

- `afd.runner.url`: the server's address, e.g. `https://flows.example.net:8443`.
- **Ansible Flow: Set Server Token**: a personal access token (**My account** on the server). It is
  checked against the server and kept in VS Code's SecretStorage only. **Clear Server Token**
  removes it. A token made for one workspace reaches that workspace only; a read-only token cannot
  run anything.
- `afd.runner.verifyTls` (default on): turn it off only for a lab server with a self-signed
  certificate. An `http://` address on another machine is refused, because the token would travel
  unencrypted; for a lab server without TLS, turn on `afd.runner.allowHttp`. Both are read from your
  user settings only, so a repository cannot weaken them. `localhost` needs neither.

## Which project and launch configuration

- **The project:** when the repository was cloned from the server (its remote is the server's git
  address, `https://flows.example.net:8443/git/<workspace>/<project>.git`), that project. Otherwise
  set `afd.runner.project` to `<workspace>/<project>`.
- **The launch configuration:** the server runs a flow through a launch configuration of its
  project (inventory, image, credentials, start values). The one whose flow file is this flow is
  used; with several, you pick one, and the pick is remembered for this workspace. Without one,
  someone with edit access on the server adds it. Nothing is written to the flow file.

## Run

**Run on Server** (under the arrow of **Run as Skeleton** in the top bar, once `afd.runner.url` is
set, or the Command Palette):

1. Asks for the flow inputs, as a local run does. Secrets are asked each time and sent to the server
   over its connection only.
2. Asks the server what the launch would run, and confirms it: the server, the launch
   configuration, the **commit**, the targets and the inventory. **Check on Server** runs it in
   check mode (nothing changes); **Run for Real on Server** runs it for real.
3. Follows the run until it ends: steps light up on the canvas as on a local run. **Stop** stops it
   on the server. Closing the progress notification stops following only: the run goes on, and
   **Open on Server** shows it there.

**The server runs its own commit** of the project: the launch configuration's, else the newest of
the project's branch. The confirmation warns when your HEAD is another commit or you have
uncommitted changes in the flow's folder: push first so the server runs what you see. Generated
code does not count: the server generates it from the flow.

## Check your work before you push it

When the confirmation says the server would run another commit than yours (HEAD not pushed, or
uncommitted changes), it also offers **Check My Work on Server**, if the server takes dev runs and
you may push:

- Your work, committed or not (new files too, ignored ones left out), is sent to the server as a git
  bundle. Your index, working tree and branches are not touched.
- The server runs it in **check mode** only, with the flow's launch configuration, and marks it a
  dev run. A real run still needs your work pushed.
- The server keeps the work for a day under a ref of its own: it never reaches the project's branch
  or the repository the project comes from.

## Approvals

A flow with approval steps waits on the server until someone allowed decides. The approval node
shows who may decide and why it waits. When the server lets you decide it, its Run tab has
**Approve** and **Reject** with a comment; the decision goes to the server as you, and the run
goes on. Who may decide is the server's to say ([approvals](approvals.md)).

## When someone changes the flow on the server

A flow open in the designer, in a clone of a server project, follows the server's branch. When
someone pushes a change to it (through the server, or to the repository the project comes from),
a note over the canvas says who and how much: "Mia Ortega changed this flow on the server: 3
steps."

- **Show changes** pulls the server's commits and opens the Changes lens against the version you
  had.
- **Update** only pulls.
- **Dismiss** puts the note away until the branch moves again.

The pull is fast-forward only. With unsaved or uncommitted changes to the flow it does nothing
and says so: commit them first, then pull and merge (with [flow merging](merging-flows.md) set up,
git merges flows by their steps). Work you have not pushed yet is not compared. A designer
opened before the token was set follows the server once you set it.

## What the server checks first

- That it is an Ansible Flow Server speaking the API this extension speaks (`v1`).
- That it reads the flow's format: a flow saved by a newer designer is refused with "upgrade the
  server".
- The server's own refusals (no access, a read-only token, an input that does not fit) are shown
  in its words.

The local run audit log (**Show Run Audit Log**) records each launch on the server with its run
number and commit; the server's audit log is the record of what ran.
