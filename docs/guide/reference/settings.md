# Settings

Examples for common setups are in [settings for common setups](../how-to/settings.md). Back to
the [guide](../README.md).

| Setting                            | Default | Meaning                                                                                                                                                                  |
| ---------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `afd.codegen.onSave`               | `true`  | Write `generated/` whenever a flow without errors is saved. Files edited by hand are never overwritten without asking.                                                   |
| `afd.environment.kind`             | `auto`  | Where Ansible runs: `container`, `local`, or `auto` (a container when an image is set, here or in the Red Hat Ansible extension, else local).                            |
| `afd.environment.image`            | (empty) | Execution environment image, e.g. `registry.example.net/ee/netops:2.19`. Empty: the Red Hat Ansible extension's `ansible.executionEnvironment.image` when it is enabled. |
| `afd.environment.containerEngine`  | `auto`  | `docker` or `podman`; `auto`: the Red Hat Ansible setting, else docker.                                                                                                  |
| `afd.environment.containerOptions` | `[]`    | Extra `docker run` / `podman run` arguments, one per item, e.g. `["-v", "/home/jane/.ssh:/home/ansible/.ssh:ro"]`.                                                       |
| `afd.environment.python`           | (empty) | Python with ansible-core 2.19+ for local mode. Empty: `ansible.python.interpreterPath`, else `python3`.                                                                  |
| `afd.run.inventory`                | (empty) | Inventory for runs, relative to the repository root. Empty: the default from `ansible.cfg`.                                                                              |
| `afd.run.askVaultPassword`         | `auto`  | `auto` (when the inventory or repository vars contain vault data), `always` or `never`. The password is used for one run and never stored.                               |
| `afd.runs.keep`                    | `30`    | Run folders (event logs) kept per flow in the extension's storage; older ones are deleted when a run starts. Run input values are never kept.                            |
| `afd.awx.url`                      | (empty) | AWX address, e.g. `https://awx.example.net`. The token is kept in SecretStorage (_Set AWX Token_), never in settings.                                                    |
| `afd.awx.verifyTls`                | `true`  | Verify AWX's TLS certificate. Turn off only for a lab AWX with a self-signed certificate.                                                                                |

## Restricted Mode

In a workspace you have not trusted, you can open, design and edit flows and generate playbooks.
Local runs and the Ansible probe (module catalog, lenses, Re-sync) use the repository's
`ansible.cfg`, plugins and playbooks, which are code, so they wait until you trust the workspace.
The workspace's values of the `afd.environment.*` and `afd.awx.*` settings are ignored there, so
an untrusted repository cannot choose the program that runs or the AWX your token goes to: only
your user settings apply.
