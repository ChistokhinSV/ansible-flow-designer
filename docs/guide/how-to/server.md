# Ansible Flow Server

Run flows on [Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server), your
team's server for flows, and follow them on the canvas. The server runs flows from its projects
(git repositories), with launch configurations, access levels, approvals and an audit log; this
page is about running one from VS Code.

## Connect

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

## What the server checks first

- That it is an Ansible Flow Server speaking the API this extension speaks (`v1`).
- That it reads the flow's format: a flow saved by a newer designer is refused with "upgrade the
  server".
- The server's own refusals (no access, a read-only token, an input that does not fit) are shown
  in its words.

The local run audit log (**Show Run Audit Log**) records each launch on the server with its run
number and commit; the server's audit log is the record of what ran.
