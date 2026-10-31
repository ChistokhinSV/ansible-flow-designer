# Approvals become AWX approval nodes

A flow whose approvals are on the top level, one waiting at a time, runs in AWX as a **workflow**:

- the playbook is cut into segments at each approval;
- **approved** continues the workflow; **denied** or **timed out** take the approval's `rejected`
  (and `timeout`) path;
- nobody arriving at a gate skips it.

Approvals inside subflows, or two waiting at once, run only locally; the validator says why.
Local runs approve by themselves. Choose another outcome with
`-e '{"afd_approvals": {"approve": "rejected"}}'`.
