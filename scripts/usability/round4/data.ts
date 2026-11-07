// Round 4's workspace names and planted faults (AFD-109, variant D): load balancers in two data
// centres, so no answer of rounds 1-3 carries over. The cards, the builder and the checks read them
// from here, so a card never names something the workspace does not have. Every name and host is
// fictional, and every host uses the local connection.
import type { ModuleStep } from '../round3/data';
import type { Step, Variant } from '../variants';

export type { ModuleStep };

const step = (key: string, title: string, intent: string, msg: string): Step => ({
  key,
  title,
  intent,
  msg,
});

const EAST = ['lab-lb-41', 'lab-lb-42', 'lab-lb-43'];
const WEST = ['lab-lb-44', 'lab-lb-45', 'lab-lb-46'];
/** The zone serial every balancer should have (D7). */
const SERIAL = 2026110701;

export const D = {
  repo: 'Load balancer operations',
  deviceWord: 'load balancer',
  devicesWord: 'load balancers',
  /** Two data centres under `lab`: a run picks one by its hosts (D7). */
  groups: { dc_east: EAST, dc_west: WEST } as Record<string, string[]>,
  /**
   * lab-lb-42 and lab-lb-45 have an old zone serial and lab-lb-43's resolver is down (D7);
   * lab-lb-44 has one member up and lab-lb-46's peer is out of sync (D8).
   */
  hosts: [
    {
      name: 'lab-lb-41',
      vars: { zone_serial: `${SERIAL}`, resolver_up: 'yes', members_up: '3', peer_sync: 'yes' },
    },
    {
      name: 'lab-lb-42',
      vars: { zone_serial: '2026103101', resolver_up: 'yes', members_up: '3', peer_sync: 'yes' },
    },
    {
      name: 'lab-lb-43',
      vars: { zone_serial: `${SERIAL}`, resolver_up: 'no', members_up: '3', peer_sync: 'yes' },
    },
    {
      name: 'lab-lb-44',
      vars: { zone_serial: `${SERIAL}`, resolver_up: 'yes', members_up: '1', peer_sync: 'yes' },
    },
    {
      name: 'lab-lb-45',
      vars: { zone_serial: '2026102401', resolver_up: 'yes', members_up: '3', peer_sync: 'yes' },
    },
    {
      name: 'lab-lb-46',
      vars: { zone_serial: `${SERIAL}`, resolver_up: 'yes', members_up: '3', peer_sync: 'no' },
    },
  ],

  /** D2-D6: one flow, a step for each task. */
  pool: {
    key: 'pool-maintenance',
    name: 'Pool maintenance',
    goal: 'Take the web pool out of service on each load balancer and report its state.',
    readKey: {
      key: 'read-key',
      title: 'Read the API key',
      intent: 'Read the key the balancer API needs.',
      module: 'ansible.builtin.command',
      params: { cmd: 'cat /etc/lb/api.key' },
    } satisfies ModuleStep,
    readState: {
      key: 'read-state',
      title: 'Read the pool state',
      intent: 'Read the state of the web pool.',
      module: 'ansible.builtin.command',
      params: { cmd: 'lbctl pool show web' },
    } satisfies ModuleStep,
    disable: {
      key: 'disable-members',
      title: 'Disable the pool members',
      intent: 'Take each member of the web pool out of service.',
      module: 'ansible.builtin.command',
      params: { cmd: 'lbctl member disable MEMBER' },
    } satisfies ModuleStep,
    wait: {
      key: 'wait-drain',
      title: 'Wait for the pool to drain',
      intent: 'The pool reports that no sessions are left.',
      module: 'ansible.builtin.command',
      params: { cmd: 'lbctl pool drain-status web' },
    } satisfies ModuleStep,
    report: {
      key: 'report-state',
      title: 'Report the pool state',
      intent: 'Print the state of the pool.',
      module: 'ansible.builtin.debug',
      params: { msg: 'Pool state: unknown' },
    } satisfies ModuleStep,
    /** D2: planted on the wait step; the card asks how long one try can take. */
    timeout: '30s',
    timeoutSeconds: 30,
    retries: 12,
    delay: 10,
    until: 'drained',
    /** D4. */
    members: ['web-01', 'web-02', 'web-03'],
    placeholder: 'MEMBER',
    /** D6: a run-time value with a default. */
    drainWait: 300,
  },

  /** D7: a check run on one data centre fails at two checks there, and at one in the other. */
  dns: {
    key: 'dns-sync',
    name: 'DNS record sync',
    goal: 'Push the service records to every load balancer and reload its resolver.',
    serial: {
      ...step(
        'check-serial',
        'Check the zone serial is current',
        `The zone serial is ${SERIAL} or newer.`,
        '',
      ),
      that: `hostvars[inventory_hostname].zone_serial | int >= ${SERIAL}`,
      failMsg: `Zone serial {{ hostvars[inventory_hostname].zone_serial }} is older than ${SERIAL}`,
      fails: 'lab-lb-42',
    },
    resolver: {
      ...step('check-resolver', 'Check the resolver answers', 'The local resolver answers.', ''),
      that: 'hostvars[inventory_hostname].resolver_up | bool',
      failMsg: 'The resolver does not answer',
      fails: 'lab-lb-43',
    },
    push: step('push-records', 'Push the records', 'Write the service records.', 'Records pushed'),
    reload: step('reload-resolver', 'Reload the resolver', 'Reload the resolver.', 'Reloaded'),
  },
  /** D7: the data centre asked for, and the host in the other one that fails too. */
  dc: 'dc_east',
  other: 'lab-lb-45',

  /** D8: the health flow's shape of rounds 1-3. */
  health: {
    key: 'pool-health',
    name: 'Pool health check',
    goal: 'Find load balancers that need attention before the next change window.',
    reported: 'Reported to the NOC',
    first: {
      ...step(
        'check-members',
        'Check enough members are up',
        'At least two members of the web pool are up.',
        '',
      ),
      that: 'hostvars[inventory_hostname].members_up | int >= 2',
      failMsg: 'Only {{ hostvars[inventory_hostname].members_up }} member up',
      fails: 'lab-lb-44',
    },
    second: {
      ...step('check-peer', 'Check the peer is in sync', 'The peer load balancer is in sync.', ''),
      that: 'hostvars[inventory_hostname].peer_sync | bool',
      failMsg: 'The peer is not in sync',
      fails: 'lab-lb-46',
    },
    collect: step(
      'collect-stats',
      'Collect pool statistics',
      'Read the pool counters.',
      'Statistics collected',
    ),
    scenarioName: 'a load balancer whose peer is out of sync is reported to the NOC',
  } satisfies Variant['health'],

  /** D9, D10: the upgrade flow's shape of rounds 1-3. */
  upgrade: {
    key: 'lb-upgrade',
    name: 'Load balancer upgrade',
    goal: 'Upgrade a load balancer pair one balancer at a time, with checks before and after.',
    approval: 'Approve the change window',
    approvalIntent: 'The change manager approves the window.',
    midApproval: {
      key: 'approve-upgrade',
      title: 'Approve the upgrade',
      intent: 'The on-call engineer confirms the balancer carries no traffic.',
      after: 'drain',
    },
    needsRoot: 'restart-healthd',
    noRoot: 'write-summary',
    subflows: [
      {
        key: 'precheck',
        title: 'Pre-checks',
        intent: 'Make sure the balancer can be upgraded safely.',
        steps: [
          {
            key: 'check-disk',
            title: 'Check free disk space',
            intent: 'At least 2 GB free for the image.',
            msg: 'Disk space checked',
          },
          {
            key: 'check-backup',
            title: 'Check a config backup exists',
            intent: 'A backup from today exists.',
            msg: 'Backup found',
          },
          {
            key: 'record-pools',
            title: 'Record the pool states',
            intent: 'Save the pool states for the comparison.',
            msg: 'Pool states recorded',
          },
        ],
      },
      {
        key: 'drain',
        title: 'Drain the balancer',
        intent: 'Move the traffic to the peer balancer.',
        steps: [
          {
            key: 'move-vips',
            title: 'Move the VIPs to the peer',
            intent: 'Make the peer own every VIP.',
            msg: 'VIPs moved',
          },
          {
            key: 'wait-sessions',
            title: 'Wait for sessions to end',
            intent: 'Wait until no sessions are left.',
          },
          {
            key: 'mute-alerts',
            title: 'Mute monitoring',
            intent: 'Silence monitoring for this balancer.',
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
            intent: 'Copy the image to the balancer.',
            msg: 'Image copied to /images',
          },
          {
            key: 'install-image',
            title: 'Install the image',
            intent: 'Activate the new image.',
            msg: 'Image installed',
          },
          {
            key: 'restart-healthd',
            title: 'Restart the health daemon',
            intent: 'Restart the health daemon so it reads the new probes.',
            msg: 'Health daemon restarted',
            become: true,
          },
          {
            key: 'reboot',
            title: 'Reboot the balancer',
            intent: 'Reboot into the new image.',
            msg: 'Rebooting',
          },
          {
            key: 'wait-balancer',
            title: 'Wait for the balancer',
            intent: 'Wait until the management API answers again.',
          },
        ],
      },
      {
        key: 'verify',
        title: 'Verify the balancer',
        intent: 'Compare the balancer with its state before the upgrade.',
        steps: [
          {
            key: 'check-vips',
            title: 'Check the VIPs answer',
            intent: 'Every VIP answers on its port.',
            msg: 'VIPs answer',
          },
          {
            key: 'compare-pools',
            title: 'Compare the pool states',
            intent: 'Pool states match the recorded ones.',
          },
          {
            key: 'write-summary',
            title: 'Write the change summary',
            intent: 'Write what changed into the change ticket.',
            msg: 'Change summary written',
            become: true,
          },
          {
            key: 'healthy',
            title: 'Is the balancer healthy?',
            intent: 'Only healthy balancers take their traffic back.',
            kind: 'decision',
            condition: "inventory_hostname not in groups.get('degraded', [])",
          },
        ],
      },
      {
        key: 'restore',
        title: 'Restore service',
        intent: 'Give the balancer its traffic back.',
        steps: [
          {
            key: 'unmute-alerts',
            title: 'Unmute monitoring',
            intent: 'Turn monitoring back on.',
            msg: 'Monitoring unmuted',
          },
          {
            key: 'move-back',
            title: 'Move the VIPs back',
            intent: 'Make this balancer own its VIPs again.',
            msg: 'VIPs moved back',
          },
          {
            key: 'tell-noc',
            title: 'Tell the NOC',
            intent: 'Post the result to the NOC channel.',
          },
        ],
      },
    ],
  } satisfies Variant['upgrade'],

  /** D10: what the colleague's commit changes in the upgrade flow. */
  outside: {
    added: {
      ...step(
        'check-health-probes',
        'Check the health probes pass',
        'Every health probe passes on the peer.',
        'Health probes pass',
      ),
      sub: 'drain',
      after: 'drain/move-vips.ok_hosts',
    },
    renamed: {
      node: 'verify/check-vips',
      was: 'Check the VIPs answer',
      title: 'Check the VIPs and their certificates answer',
    },
    rebound: {
      node: 'upgrade/copy-image',
      title: 'Copy the image',
      msg: 'Image copied to /images/next',
    },
  } satisfies Variant['outside'],
  /** D10: one more change, so the list shows a settings line too. */
  retimed: { node: 'upgrade/wait-balancer', title: 'Wait for the balancer', retries: 5, delay: 30 },
  colleague: { name: 'M. Lindqvist', email: 'm.lindqvist@lab.example' },

  /** D1: a wire to a port that does not exist. */
  audit: {
    key: 'vip-audit',
    name: 'VIP audit',
    goal: 'Check every virtual IP against the approved list.',
    steps: [
      step('list-vips', 'List the VIPs', 'Read the configured virtual IPs.', 'VIPs listed'),
      step(
        'compare-approved',
        'Compare with the approved list',
        'Every VIP is on the approved list.',
        'VIPs compared',
      ),
      step('report-vips', 'Report unknown VIPs', 'Report what is not approved.', 'Reported'),
    ],
  } satisfies Variant['audit'],

  /** D1: its generated playbook was changed by hand. */
  renewal: {
    key: 'cert-renewal',
    name: 'Certificate renewal',
    goal: 'Renew the certificates that expire soon.',
    list: {
      key: 'list-expiring',
      title: 'List expiring certificates',
      intent: 'Find the certificates that expire within the renewal period.',
      module: 'ansible.builtin.command',
      params: { cmd: 'lbctl cert list --expiring 30d' },
    } satisfies ModuleStep,
    steps: [
      step('renew', 'Renew the certificates', 'Request and install new ones.', 'Renewed'),
      step('report-renewal', 'Report the renewal', 'Say what was renewed.', 'Renewal reported'),
    ],
    handEdit: { from: '--expiring 30d', to: '--expiring 45d' },
  },

  /** No task: a clean flow with hand-placed steps and a section. */
  pipeline: {
    key: 'config-pipeline',
    name: 'Config bundle pipeline',
    goal: 'Validate, test and package the load balancer configuration.',
    section: 'Build',
    steps: [
      step('fetch', 'Fetch the configuration', 'Check out the configuration sources.', 'Fetched'),
      step('lint', 'Lint', 'Check the configuration syntax.', 'Clean'),
      step('render', 'Render', 'Render the configuration for each balancer.', 'Rendered'),
      step('bundle', 'Bundle', 'Build the configuration bundle.', 'Bundled'),
      step('sign', 'Sign the bundle', 'Sign the bundle for release.', 'Signed'),
      step('publish', 'Publish', 'Publish the bundle to the repository.', 'Published'),
    ],
  } satisfies Variant['pipeline'],
};

export type RoundFour = typeof D;
