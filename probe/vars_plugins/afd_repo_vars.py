# Ansible Flow Designer (AFD-291): group_vars/ and host_vars/ at the repository root, as if they
# were next to the playbook. Generated playbooks live in flows/<key>/generated/, so Ansible's own
# host_group_vars plugin finds the root's folders only when the inventory is there too. A run
# enables this plugin (ANSIBLE_VARS_ENABLED) and names the root in AFD_REPO_ROOT; like playbook
# group_vars, what it loads wins over the inventory's.
import os

from ansible.plugins.vars.host_group_vars import VarsModule as HostGroupVars

DOCUMENTATION = """
    name: afd_repo_vars
    short_description: group_vars and host_vars of the repository root
    description: Loads group_vars/ and host_vars/ from the folder AFD_REPO_ROOT names.
    options:
      stage:
        ini:
          - key: stage
            section: vars_afd_repo_vars
        env:
          - name: ANSIBLE_VARS_PLUGIN_STAGE
    extends_documentation_fragment:
      - vars_plugin_staging
"""


class VarsModule(HostGroupVars):
    REQUIRES_ENABLED = True

    def get_vars(self, loader, path, entities, cache=True):
        root = os.environ.get("AFD_REPO_ROOT")
        if not root:
            return {}
        return super().get_vars(loader, root, entities, cache)
