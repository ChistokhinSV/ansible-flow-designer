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
- **ansible-core is older than 2.19:** the error names the version found. Use a newer image or
  venv.
- **A lens, Re-sync or a run waits for the catalog:** it no longer does: reading the collection
  docs runs in a probe of its own. A call that times out restarts the probe for the next one; the
  details are in the _Ansible Flow_ output channel.
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

## Imports

- **"No playbooks in …":** a playbook is a YAML list of plays (`hosts:`) or `import_playbook`
  entries. Task files, vars files and roles are imported through the playbooks that use them.
- **A role step is a draft, or the notes say "add its folder to roles_path":** generated playbooks
  find roles through the repository's `ansible.cfg`. Add the role's folder to `roles_path` under
  `[defaults]`, then import again.
- **A step is a draft with "not fully qualified":** the module's short name is not an
  `ansible.builtin` module and the module catalog is not loaded. Open the step's properties and bind
  the full name (for example `cisco.ios.ios_config`), or open a flow first so the catalog loads.
- **"not read in because its file name is templated" or "it runs in a loop":** dynamic includes have
  no fixed content to import. Bind the step, or make it a subflow by hand.
- **A file "is encrypted with Ansible Vault as a whole":** the import never decrypts. Values from it
  are read by name where tasks use them.
- **"The sample playbooks bring ansible.cfg, …":** open an empty folder for Tutorial 5's sample.
- **With an AI assistant, nothing happens after pasting the prompt:** the assistant needs the
  Ansible Flow tools. Run **Set Up AI Assistants…** and restart it.

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
print to their terminal (**Show terminal** in the run panel). The _Ansible Flow_ output channel
(View → Output) logs the Ansible probe: when it starts, which ansible-core it found, its warnings
and timeouts (set the channel's level to Debug for every probe line), and what _Set Up AI
Assistants_ wrote (lines starting with "AI setup").
