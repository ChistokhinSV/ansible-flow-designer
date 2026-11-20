// AFD-340: a fictional repository for the harness, so the designer shows where a value comes from
// with the repository's variables (inventory, group_vars/host_vars, a role, a playbook's
// include_vars). The index is built by the same core code the extension uses.

import type { FlowDocument } from '../../core/flow/types';
import { memoryFs } from '../../core/inventory/memoryFs';
import { buildVarIndex, indexInputs, type VarIndex } from '../../core/inventory/varIndex';

const FILES: Record<string, string> = {
  'ansible.cfg': '[defaults]\ninventory = inventory/hosts.yml\n',
  'inventory/hosts.yml': [
    'all:',
    '  vars:',
    '    ntp_server: 192.0.2.1',
    '  children:',
    '    dc_ams:',
    '      vars:',
    '        ntp_server: 192.0.2.2',
    '      children:',
    '        edge:',
    '          hosts:',
    '            edge-ams-01:',
    '              ntp_server: 192.0.2.9',
    '            edge-ams-02:',
    '        core:',
    '          hosts:',
    '            core-ams-01:',
    '',
  ].join('\n'),
  'inventory/group_vars/all.yml': [
    '# Every device',
    'syslog_host: 198.51.100.5',
    'ntp_server: 192.0.2.3',
    'snmp_community: !vault |',
    '  $ANSIBLE_VAULT;1.1;AES256',
    '  3966353766386135',
    '',
  ].join('\n'),
  'inventory/group_vars/edge.yml': 'ntp_server: 192.0.2.4\n',
  'group_vars/edge.yml': 'ntp_server: "{{ ntp_pool }}"\n',
  'inventory/host_vars/edge-ams-02.yml': 'mtu: 1500\n',
  'roles/nginx/tasks/main.yml': '- ansible.builtin.debug: msg=nginx\n',
  'roles/nginx/defaults/main.yml': 'nginx_port: 80\nnginx_user: www-data\n',
  'roles/nginx/vars/main.yml': 'nginx_user: nginx\n',
  'roles/nginx/meta/argument_specs.yml': [
    'argument_specs:',
    '  main:',
    '    options:',
    '      nginx_port:',
    '        type: int',
    '        default: 80',
    '        description: The port nginx listens on',
    '',
  ].join('\n'),
  'playbooks/site.yml': [
    '- hosts: all',
    '  tasks:',
    '    - ansible.builtin.include_vars: site.yml',
    '',
  ].join('\n'),
  'playbooks/vars/site.yml': 'mtu: 9000\n',
};

/** The index the extension would send for this flow. */
export function fakeVarIndex(doc: FlowDocument): Promise<VarIndex> {
  return buildVarIndex(memoryFs(FILES), { inventory: '', ...indexInputs(doc.nodes) });
}
