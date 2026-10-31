# Set up the template

**Ansible Flow: Set Up AWX Template** asks for the AWX project that holds this repository, an
inventory, an execution environment (ansible-core 2.19+) and credentials. Then it creates or
updates:

- the **job template** `AFD · <flow key>` for the generated playbook `generated/<key>.yml`;
- for a flow with **top-level approvals**: a job template per segment playbook and the
  **workflow** `AFD · <flow key>`, with an approval node at each gate (timeout from the approval's
  `settings.timeout`).

It writes the name to `flow.runtime`. AWX runs what is in the project's Git remote: commit and
push the flow and `generated/` first, or the setup stops and names the missing playbooks.
