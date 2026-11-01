# Settings for common setups

Every setting is listed in the [settings reference](../reference/settings.md). Put them in your
workspace's `.vscode/settings.json` to share them with your team, or in your user settings for
machine-specific ones. All values below are examples.

## Windows with Docker Desktop

```json
{
  "afd.environment.image": "registry.example.net/ee/netops:2.19",
  "afd.run.inventory": "inventories/lab/hosts.yml",
  "afd.environment.containerOptions": ["-v", "C:/Users/jane/.ssh:/home/ansible/.ssh:ro"]
}
```

## WSL, SSH or a Dev Container (VS Code Remote)

Open the repository in the remote; install Ansible there. Nothing else is needed: the environment
is local to the remote.

```json
{
  "afd.run.inventory": "inventories/prod/hosts.yml",
  "afd.run.askVaultPassword": "always"
}
```

## A local virtual environment

```json
{
  "afd.environment.python": "/home/jane/netops/.venv/bin/python"
}
```

Or leave it empty: the Red Hat Ansible extension's `ansible.python.interpreterPath` is used, else
`python3`.

## AWX

```json
{
  "afd.awx.url": "https://awx.example.net"
}
```

The token never goes into settings: **Ansible Flow: Set AWX Token**.

## Turn off code generation on save

```json
{
  "afd.codegen.onSave": false
}
```

Then use **Ansible Flow: Generate Code** when you want the files.
