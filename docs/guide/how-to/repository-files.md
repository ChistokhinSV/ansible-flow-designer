# Files, templates and variables in the repository

A flow lives in your Ansible repository next to everything else: templates, files, variables, roles,
your own modules and plugins. You keep them where Ansible expects them; the designer does not copy
or import them. This page says where to put them so a flow's runs find them.

Generated playbooks are in `flows/<key>/generated/`, not next to your files, so a run adds the
repository's folders to what Ansible looks at, wherever the run is: on this machine, in a
container, in WSL or over SSH. (Ansible Flow Server reads a step's paths from the root too; its runs
do not add your modules, plugins and root `group_vars` yet.)

## Where things go

| What                                                           | Where                                                                                         | How a run finds it                                                                                        |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| A template, a file to copy, a script, a vars file a step reads | anywhere in the repository, written in the step from the repository root: `templates/motd.j2` | the generated task reads `{{ afd_repo_root }}/templates/motd.j2`; a missing file is a warning on the step |
| Roles                                                          | `roles/` (or what `roles_path` in `ansible.cfg` says)                                         | Ansible's role path, as for any playbook; a role's own `files/`, `templates/`, `defaults/` go with it     |
| Your modules                                                   | `library/`, with shared code in `module_utils/`                                               | added to Ansible's module path for the run                                                                |
| Your plugins                                                   | `filter_plugins/`, `lookup_plugins/`, `test_plugins/`, `action_plugins/`                      | added to Ansible's plugin paths for the run                                                               |
| Variables for groups and hosts                                 | `group_vars/`, `host_vars/` at the repository root, or next to the inventory                  | both load; those at the root win over the inventory's, as playbook `group_vars` do                        |
| Collections                                                    | the execution environment's image, or `collections/` with `ansible.cfg`                       | Ansible's collection path                                                                                 |
- **A path in a step is from the repository root.** Write `templates/motd.j2`, not `motd.j2`:
  Ansible's habit of looking in `templates/` next to the playbook does not apply, the playbook
  being in `generated/`. An absolute path, a path with `{{ }}` in it, and `remote_src: true` are
  left as they are.
- **Import keeps your files where they are.** Playbooks imported into a flow have their template,
  copy and vars sources written from the root (`{{ afd_repo_root }}/…`), found as Ansible found
  them from the source playbook.
- **Your `ansible.cfg` still counts.** Paths it gives (`library`, `filter_plugins`, `roles_path`,
  ...) come first; the repository's folders are added after them.
- **Not for scenario simulations:** a simulated run uses an empty Ansible config and no plugin of
  the repository.

## See also

- [Bind a step to a module, role or playbook](binding-and-catalog.md)
- [Generated code](code-generation.md): `afd_repo_root` and what the generated plays set
- [Import playbooks and AWX templates](import.md)
