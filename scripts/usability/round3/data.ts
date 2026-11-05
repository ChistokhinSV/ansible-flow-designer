// Round 3's workspace names and planted faults (AFD-99, variant C): firewalls in two sites, so no
// answer of rounds 1 and 2 carries over. The cards, the builder and the checks read them from here,
// so a card never names something the workspace does not have. Every name and host is fictional.
import type { Step, Variant } from '../variants';

const step = (key: string, title: string, intent: string, msg: string): Step => ({
  key,
  title,
  intent,
  msg,
});

/** A step bound to a module: its key, title, intent and the module's parameters. */
export interface ModuleStep {
  key: string;
  title: string;
  intent: string;
  module: string;
  params: Record<string, unknown>;
}

const NORTH = ['lab-fw-31', 'lab-fw-32', 'lab-fw-33'];
const SOUTH = ['lab-fw-34', 'lab-fw-35', 'lab-fw-36'];

export const C = {
  repo: 'Edge security automation',
  deviceWord: 'firewall',
  devicesWord: 'firewalls',
  /** Two sites under `lab`: a run picks one by its hosts (T10). */
  groups: { site_north: NORTH, site_south: SOUTH } as Record<string, string[]>,
  /** lab-fw-33 and lab-fw-35 run an old policy; lab-fw-36 has no HA peer. */
  hosts: [
    { name: 'lab-fw-31', vars: { policy_version: '43', ha_peer: 'yes' } },
    { name: 'lab-fw-32', vars: { policy_version: '44', ha_peer: 'yes' } },
    { name: 'lab-fw-33', vars: { policy_version: '40', ha_peer: 'yes' } },
    { name: 'lab-fw-34', vars: { policy_version: '43', ha_peer: 'yes' } },
    { name: 'lab-fw-35', vars: { policy_version: '41', ha_peer: 'yes' } },
    { name: 'lab-fw-36', vars: { policy_version: '43', ha_peer: 'no' } },
  ],

  /** T1, T2. */
  baseline: {
    key: 'fw-baseline',
    name: 'Firewall baseline',
    goal: 'Every firewall answers, shows the login banner and keeps its configuration.',
    check: step(
      'check-answers',
      'Check the firewall answers',
      'The management interface answers.',
      'Firewall answers',
    ),
    banner: {
      key: 'write-banner',
      title: 'Write the login banner',
      intent: 'Write the standard login banner.',
    },
    save: step(
      'save-config',
      'Save the configuration',
      'Write the running configuration to startup.',
      'Configuration saved',
    ),
    /** T1: the step to put between the check and the banner. */
    insert: 'Check management access',
    /** T2: the binding asked for (only dest is required). */
    bind: {
      module: 'ansible.builtin.copy',
      params: {
        content: 'Managed by SecOps',
        dest: '/etc/issue.net',
        owner: 'root',
        mode: '0644',
      },
    },
  },

  /** T3, T4, T6. */
  deploy: {
    key: 'rule-deploy',
    name: 'Rule set deploy',
    goal: 'Install the edge rule set on every firewall and report the software it runs.',
    push: {
      key: 'push-rules',
      title: 'Push the rule set',
      intent: 'Copy the rule file to the firewall.',
      module: 'ansible.builtin.copy',
      params: {
        src: 'files/edge.rules',
        dest: '/etc/fw/rules.d/edge.rules',
        mode: '0644',
        backup: true,
      },
    } satisfies ModuleStep,
    wait: {
      key: 'wait-policy',
      title: 'Wait for the policy to install',
      intent: 'The firewall reports the new policy as installed.',
      module: 'ansible.builtin.command',
      params: { cmd: 'fwctl policy status' },
    } satisfies ModuleStep,
    read: {
      key: 'read-version',
      title: 'Read the software version',
      intent: 'Read the running software version.',
      module: 'ansible.builtin.command',
      params: { cmd: 'fwctl show version' },
    } satisfies ModuleStep,
    report: {
      key: 'report-version',
      title: 'Report the version',
      intent: 'Print the version the firewall runs.',
      module: 'ansible.builtin.debug',
      params: { msg: 'Version: unknown' },
    } satisfies ModuleStep,
    /** T3: the mode asked for; backup goes. */
    mode: '0600',
    /** T6. */
    retries: 10,
    delay: 15,
    until: 'installed',
  },

  /** T5, T8, T9. */
  backup: {
    key: 'config-backup',
    name: 'Config backup',
    goal: 'Export every zone of each firewall and upload the export to the archive.',
    readKey: {
      key: 'read-key',
      title: 'Read the backup key',
      intent: 'Read the key the export is encrypted with.',
      module: 'ansible.builtin.command',
      params: { cmd: 'cat /etc/fw/backup.key' },
    } satisfies ModuleStep,
    exportZones: {
      key: 'export-zones',
      title: 'Export the zone rules',
      intent: 'Export the rules of each security zone.',
      module: 'ansible.builtin.command',
      params: { cmd: 'fwctl export --zone ZONE' },
    } satisfies ModuleStep,
    upload: {
      key: 'upload',
      title: 'Upload to the archive',
      intent: 'Send the export to the archive server.',
      module: 'ansible.builtin.uri',
      params: { url: 'https://archive-01.lab.example/upload', method: 'POST' },
    } satisfies ModuleStep,
    server: 'archive-01.lab.example',
    /** T5: the description the card asks for. */
    description: 'Archive server to upload to',
    /** T8. */
    user: 'svc-backup',
    /** T9. */
    zones: ['trust', 'untrust', 'dmz'],
  },

  /** T10, T12: the health flow's shape of rounds 1 and 2. */
  health: {
    key: 'fw-health',
    name: 'Firewall health check',
    goal: 'Find firewalls that need attention before the next change window.',
    reported: 'Reported to SecOps',
    first: {
      ...step(
        'check-policy',
        'Check the policy version is current',
        'The policy version is 42 or newer.',
        '',
      ),
      that: 'hostvars[inventory_hostname].policy_version | int >= 42',
      failMsg: 'Policy version {{ hostvars[inventory_hostname].policy_version }} is older than 42',
      /** In site_south; lab-fw-33 fails it too, in site_north. */
      fails: 'lab-fw-35',
    },
    second: {
      ...step(
        'check-ha',
        'Check the HA pair is in sync',
        'The HA peer is present and in sync.',
        '',
      ),
      that: 'hostvars[inventory_hostname].ha_peer | bool',
      failMsg: 'No HA peer in sync',
      fails: 'lab-fw-36',
    },
    collect: step(
      'collect-sessions',
      'Collect session counters',
      'Read the session table counters.',
      'Counters collected',
    ),
    scenarioName: 'a firewall without an HA peer is reported to SecOps',
  } satisfies Variant['health'],
  /** T10: the site asked for and the north host that fails as well. */
  site: 'site_south',
  north: 'lab-fw-33',

  /** T11: three inputs with short names, explained by their descriptions. */
  rollout: {
    key: 'rule-rollout',
    name: 'Rule rollout',
    goal: 'Install an approved rule set on the lab firewalls in its maintenance window.',
    inputs: {
      rs_tag: {
        description: 'Rule set to install: its release tag, like edge-v40',
        value: 'edge-v42',
      },
      mw: { description: 'Maintenance window in UTC, HH:MM-HH:MM', value: '22:00-23:00' },
      chg: { description: 'Approved change ticket', value: 'CHG-3121' },
    } as Record<string, { description: string; value: string }>,
    steps: [
      {
        ...step(
          'announce',
          'Announce the change',
          'Say which change runs on each firewall.',
          'Change {{ chg }} on {{ inventory_hostname }}',
        ),
        reads: ['chg'],
      },
      {
        ...step(
          'install-rules',
          'Install the rule set',
          'Install the approved rule set.',
          'Rule set {{ rs_tag }}',
        ),
        reads: ['rs_tag'],
      },
      {
        ...step(
          'schedule',
          'Schedule the activation',
          'Activate the rules inside the window.',
          'Window {{ mw }} UTC',
        ),
        reads: ['mw'],
      },
    ],
  },

  /** T7, T15, T16: the upgrade flow's shape of rounds 1 and 2. */
  upgrade: {
    key: 'fw-upgrade',
    name: 'Firewall upgrade',
    goal: 'Upgrade a firewall pair one firewall at a time, with checks before and after.',
    approval: 'Approve the change window',
    approvalIntent: 'The change manager approves the window.',
    midApproval: {
      key: 'approve-upgrade',
      title: 'Approve the upgrade',
      intent: 'The on-call engineer confirms the firewall is idle.',
      after: 'failover',
    },
    needsRoot: 'restart-logd',
    noRoot: 'write-summary',
    subflows: [
      {
        key: 'precheck',
        title: 'Pre-checks',
        intent: 'Make sure the firewall can be upgraded safely.',
        steps: [
          {
            key: 'check-disk',
            title: 'Check free disk space',
            intent: 'At least 4 GB free for the image.',
            msg: 'Disk space checked',
          },
          {
            key: 'check-backup',
            title: 'Check a config backup exists',
            intent: 'A backup from today exists.',
            msg: 'Backup found',
          },
          {
            key: 'check-peer',
            title: 'Check the HA peer state',
            intent: 'The peer is active and in sync.',
            msg: 'HA peer in sync',
          },
          {
            key: 'record-sessions',
            title: 'Record the session counts',
            intent: 'Save the session counts for the comparison.',
            msg: 'Session counts recorded',
          },
        ],
      },
      {
        key: 'failover',
        title: 'Fail over to the peer',
        intent: 'Move traffic to the peer firewall.',
        steps: [
          {
            key: 'move-traffic',
            title: 'Move traffic to the peer',
            intent: 'Make the peer the active firewall.',
            msg: 'Traffic moved',
          },
          {
            key: 'wait-drain',
            title: 'Wait for sessions to drain',
            intent: 'Wait until fewer than 100 sessions are left.',
          },
          {
            key: 'mute-alerts',
            title: 'Mute monitoring',
            intent: 'Silence monitoring for this firewall.',
            msg: 'Monitoring muted',
          },
        ],
      },
      {
        key: 'upgrade',
        title: 'Upgrade the software',
        intent: 'Install the new image and restart.',
        steps: [
          {
            key: 'copy-image',
            title: 'Copy the image',
            intent: 'Copy the image to the firewall.',
            msg: 'Image copied to disk:',
          },
          {
            key: 'verify-checksum',
            title: 'Verify the image checksum',
            intent: 'The checksum matches the release notes.',
            msg: 'Checksum matches',
          },
          {
            key: 'restart-logd',
            title: 'Restart the log daemon',
            intent: 'Restart logging so it writes to the new partition.',
            msg: 'Log daemon restarted',
            become: true,
          },
          {
            key: 'install-image',
            title: 'Install the image',
            intent: 'Activate the new image.',
            msg: 'Image installed',
          },
          {
            key: 'reboot',
            title: 'Reboot the firewall',
            intent: 'Reboot into the new image.',
            msg: 'Rebooting',
          },
          {
            key: 'wait-firewall',
            title: 'Wait for the firewall',
            intent: 'Wait until the management interface answers again.',
          },
        ],
      },
      {
        key: 'verify',
        title: 'Verify the firewall',
        intent: 'Compare the firewall with its state before the upgrade.',
        steps: [
          {
            key: 'check-loaded',
            title: 'Check the policy is loaded',
            intent: 'The policy is loaded and enforced.',
            msg: 'Policy loaded',
          },
          {
            key: 'compare-sessions',
            title: 'Compare the session counts',
            intent: 'Session counts match the recorded state.',
          },
          {
            key: 'write-summary',
            title: 'Write the upgrade summary',
            intent: 'Write what changed into the change ticket.',
            msg: 'Upgrade summary written',
            become: true,
          },
          {
            key: 'healthy',
            title: 'Is the firewall healthy?',
            intent: 'Only healthy firewalls take their traffic back.',
            kind: 'decision',
            condition: "inventory_hostname not in groups.get('degraded', [])",
          },
        ],
      },
      {
        key: 'restore',
        title: 'Restore service',
        intent: 'Give the firewall its traffic back.',
        steps: [
          {
            key: 'unmute-alerts',
            title: 'Unmute monitoring',
            intent: 'Turn monitoring back on.',
            msg: 'Monitoring unmuted',
          },
          {
            key: 'fail-back',
            title: 'Fail back',
            intent: 'Make this firewall active again.',
            msg: 'Failed back',
          },
          {
            key: 'tell-soc',
            title: 'Tell the SOC',
            intent: 'Post the result to the SOC channel.',
          },
        ],
      },
    ],
  } satisfies Variant['upgrade'],

  /** T16: what the colleague's commit changes in the upgrade flow. */
  outside: {
    added: {
      ...step(
        'check-sessions',
        'Check the session table is empty',
        'No sessions are left on the firewall.',
        'Session table empty',
      ),
      sub: 'failover',
      after: 'failover/move-traffic.ok_hosts',
    },
    renamed: {
      node: 'verify/check-loaded',
      was: 'Check the policy is loaded',
      title: 'Check the policy and NAT rules are loaded',
    },
    rebound: { node: 'upgrade/copy-image', title: 'Copy the image', msg: 'Image copied to disk0:' },
  } satisfies Variant['outside'],
  colleague: { name: 'R. Ortiz', email: 'r.ortiz@lab.example' },

  /** T13: a wire to a port that does not exist. */
  audit: {
    key: 'vpn-audit',
    name: 'VPN audit',
    goal: 'Check every site-to-site tunnel against the approved list.',
    steps: [
      step('list-tunnels', 'List the tunnels', 'Read the configured tunnels.', 'Tunnels listed'),
      step(
        'compare-approved',
        'Compare with the approved list',
        'Every tunnel is on the approved list.',
        'Tunnels compared',
      ),
      step('report-tunnels', 'Report unknown tunnels', 'Report what is not approved.', 'Reported'),
    ],
  } satisfies Variant['audit'],

  /** T13, T14: its generated playbook keeps 30 days; the flow says 7. */
  rotation: {
    key: 'log-rotation',
    name: 'Log archive rotation',
    goal: 'Remove log archives older than the retention period.',
    find: {
      key: 'find-old',
      title: 'Find old archives',
      intent: 'Find archives older than the retention period.',
      module: 'ansible.builtin.find',
      params: { paths: '/var/log/fw-archive', patterns: '*.tar.gz', age: '7d' },
    } satisfies ModuleStep,
    steps: [
      step(
        'remove-old',
        'Remove the old archives',
        'Delete the archives found.',
        'Old archives removed',
      ),
      step('report-rotation', 'Report the rotation', 'Say what was removed.', 'Rotation reported'),
    ],
    handEdit: { from: 'age: 7d', to: 'age: 30d' },
    /** T14: the value the flow must say. */
    age: '30d',
  },

  /** No task: a clean flow with hand-placed steps and a section. */
  pipeline: {
    key: 'policy-pipeline',
    name: 'Policy pipeline',
    goal: 'Validate, test and package the firewall policy.',
    section: 'Build',
    steps: [
      step('fetch', 'Fetch the policy', 'Check out the policy sources.', 'Fetched'),
      step('validate', 'Validate', 'Validate the policy syntax.', 'Valid'),
      step('simulate', 'Simulate', 'Run the policy against recorded traffic.', 'Simulated'),
      step('package', 'Package', 'Build the policy bundle.', 'Packaged'),
      step('sign', 'Sign the bundle', 'Sign the bundle for release.', 'Signed'),
      step('publish', 'Publish', 'Publish the bundle to the repository.', 'Published'),
    ],
  } satisfies Variant['pipeline'],
};

export type RoundThree = typeof C;
