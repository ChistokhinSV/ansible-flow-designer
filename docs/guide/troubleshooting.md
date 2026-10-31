# Troubleshooting

Back to the [guide](README.md).

## The flow does not open in the designer

- **It opens as text.** Right-click the file → _Open With…_ → **Ansible Flow Designer**. Only files
  named `*.flow.yaml` open in it.
- **"… is not a flow document yet"** with an error: the YAML does not parse. **Open as text**, fix
  the line it names, and the designer comes back.
- **An empty `*.flow.yaml`** shows **Create a flow here**, which writes a start and a done node.
- **"Written by hand" banner:** the file lacks IDs. Click **Complete IDs**
  ([hand-written YAML](how-to/hand-written-yaml.md)).
- **Edits are refused with "The document has YAML errors":** fix the YAML in the text editor
  first.

## Runs, the catalog or Implementation mode do not work

These need an Ansible environment with ansible-core 2.19 or later
([runs and environments](how-to/runs-and-environments.md)).

- **"docker" (or "podman") not found:** install it, or start Docker Desktop, or set
  `afd.environment.containerEngine`. On native Windows a container is the only option; or open the
  folder in WSL.
- **The image is not found:** pull it first (`docker pull <image>`), or check
  `afd.environment.image`.
- **ansible-core is older than 2.19:** use a newer image or venv.
- **Hosts are unreachable in a container run:** the container needs your SSH keys and name
  resolution. Mount the keys with `afd.environment.containerOptions`.
- **"No hosts matched":** the targets you entered are not in the inventory. Check
  `afd.run.inventory`, or enter `localhost` for a first skeleton run.
- **The module search finds nothing:** the first search reads the collection docs (about 30
  seconds). After installing collections, run **Rebuild Module Catalog**.

## Generated code

- **A generated file was edited by hand:** the extension leaves it alone and asks before
  overwriting it. Keep your change in a role you bind, then let it regenerate.
- **Nothing is generated on save:** the flow has errors (Problems panel), or `afd.codegen.onSave` is
  off.

## AWX

- **"The flow has no AWX job template":** run **Set Up AWX Template** first.
- **The setup names missing playbooks:** commit and push the flow and `generated/`, then sync the
  AWX project.
- **TLS errors with a lab AWX:** turn off `afd.awx.verifyTls` (only for a self-signed lab
  certificate).
- **401 or 403:** the token expired or lacks rights. Run **Set AWX Token** again.
- **The run warns about another commit:** AWX runs what its project checks out. Push your changes.

## AI assistants

- **The agent does not see the flow tools:** run **Set Up AI Assistants…** and restart the agent.
  Gemini enables MCP servers only in trusted folders.
- **The agent draws PlantUML, Mermaid or draw.io instead:** say "an Ansible Flow Designer flow
  (`*.flow.yaml`)". With the skill installed, "Ansible flow" is enough.
- **"The flow changed since revision …":** the file changed between the agent's read and its edit,
  for example because you edited it. The agent reads it again and retries.
- **A terminal agent's edit clashes with unsaved changes** in VS Code: save first. VS Code asks
  which version to keep.

## Still stuck?

**Validate design** lists every problem with its fix ([problem codes](reference/problems.md)). Runs
print to their terminal (**Show terminal** in the run panel), and the AI setup logs to the
_Ansible Flow: AI setup_ output channel (View → Output).
