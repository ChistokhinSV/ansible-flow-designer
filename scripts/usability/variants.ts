// The two isomorphic variants of the usability workspace (AFD-78): the same flows, wiring and
// faults with other names. Round 1 uses A, round 2 uses B. The task cards and the verifier read the
// names and answers from here, so a card never names something the workspace does not have.
// Every name and host is fictional.

export interface Step {
  key: string;
  title: string;
  intent: string;
  msg: string;
}

interface Inner {
  key: string;
  title: string;
  intent: string;
  kind?: 'approval' | 'decision';
  /** Bound to debug with this message; absent: the step is not implemented yet. */
  msg?: string;
  become?: boolean;
  condition?: string;
}

export interface Variant {
  repo: string;
  deviceWord: string;
  devicesWord: string;
  hosts: { name: string; vars: Record<string, string> }[];
  /** T1: the flow the participant builds. */
  first: { name: string; steps: [string, string] };
  baseline: {
    key: string;
    name: string;
    goal: string;
    check: Step;
    draft: Omit<Step, 'msg'>;
    save: Step;
    /** T2: the binding asked for. */
    bind: { module: string; params: Record<string, string> };
  };
  health: {
    key: string;
    name: string;
    goal: string;
    reported: string;
    /** The host each check fails for in a real or check run. */
    first: Step & { that: string; failMsg: string; fails: string };
    second: Step & { that: string; failMsg: string; fails: string };
    collect: Step;
    scenarioName: string;
  };
  rollout: {
    key: string;
    name: string;
    goal: string;
    inputs: Record<string, { type: 'list' | 'string'; description: string; value: string }>;
    steps: (Step & { reads: string[] })[];
  };
  upgrade: {
    key: string;
    name: string;
    goal: string;
    approval: string;
    approvalIntent: string;
    /** A second top-level approval after the subflow `after`. */
    midApproval: { key: string; title: string; intent: string; after: string };
    subflows: { key: string; title: string; intent: string; steps: Inner[] }[];
    /** T9: the step that needs root (accept with a reason) and the one that does not (fix). */
    needsRoot: string;
    noRoot: string;
  };
  pipeline: { key: string; name: string; goal: string; section: string; steps: Step[] };
  audit: { key: string; name: string; goal: string; steps: Step[] };
  rotation: {
    key: string;
    name: string;
    goal: string;
    steps: Step[];
    handEdit: { from: string; to: string };
  };
  outside: {
    added: Step & { sub: string; after: string };
    renamed: { node: string; title: string; was: string };
    rebound: { node: string; msg: string; title: string };
  };
}

/**
 * Where the pipeline's nodes sit, as a careful author left them: the three build steps (indexes 1-3)
 * unevenly (T10). Keys by step index, plus start, done and failed.
 */
export function pipelineLayout(p: Variant['pipeline']): Record<string, { x: number; y: number }> {
  const at = [
    { x: 320, y: 110 },
    { x: 262, y: 262 },
    { x: 395, y: 352 },
    { x: 298, y: 548 },
    { x: 320, y: 700 },
    { x: 320, y: 820 },
  ];
  return {
    start: { x: 320, y: 0 },
    ...Object.fromEntries(p.steps.map((s, i) => [s.key, at[i] ?? { x: 320, y: 0 }])),
    done: { x: 320, y: 940 },
    failed: { x: 760, y: 560 },
  };
}

const step = (key: string, title: string, intent: string, msg: string): Step => ({
  key,
  title,
  intent,
  msg,
});

export const VARIANTS: Record<'a' | 'b', Variant> = {
  a: {
    repo: 'Branch network automation',
    deviceWord: 'switch',
    devicesWord: 'switches',
    hosts: [
      { name: 'lab-sw-01', vars: { firmware_version: '17.6', uplinks: '2' } },
      { name: 'lab-sw-02', vars: { firmware_version: '17.3', uplinks: '2' } },
      { name: 'lab-sw-03', vars: { firmware_version: '16.9', uplinks: '2' } },
      { name: 'lab-sw-04', vars: { firmware_version: '17.9', uplinks: '1' } },
    ],
    first: {
      name: 'Backup configs',
      steps: ['Check the device answers', 'Save the running config'],
    },
    baseline: {
      key: 'ntp-baseline',
      name: 'NTP baseline',
      goal: 'Every switch uses the standard NTP setup and shows the login banner.',
      check: step(
        'check-ntp',
        'Check NTP status',
        'Read the NTP peers and their state.',
        'NTP peers are in sync',
      ),
      draft: {
        key: 'set-banner',
        title: 'Set the login banner',
        intent: 'Write the standard login banner.',
      },
      save: step(
        'save-config',
        'Save the configuration',
        'Write the running configuration to startup.',
        'Configuration saved',
      ),
      bind: {
        module: 'ansible.builtin.lineinfile',
        params: { path: '/etc/issue.net', line: 'Authorized access only' },
      },
    },
    health: {
      key: 'branch-health',
      name: 'Branch health check',
      goal: 'Find branch switches that need attention before the next change window.',
      reported: 'Reported to NetOps',
      first: {
        ...step(
          'check-firmware',
          'Check firmware is supported',
          'The firmware is 17.0 or newer.',
          '',
        ),
        that: "hostvars[inventory_hostname].firmware_version is version('17.0', '>=')",
        failMsg: 'Firmware {{ hostvars[inventory_hostname].firmware_version }} is older than 17.0',
        fails: 'lab-sw-03',
      },
      second: {
        ...step(
          'check-uplink',
          'Check uplink is redundant',
          'The switch has at least two uplinks.',
          '',
        ),
        that: 'hostvars[inventory_hostname].uplinks | int >= 2',
        failMsg: 'Only {{ hostvars[inventory_hostname].uplinks }} uplink',
        fails: 'lab-sw-04',
      },
      collect: step(
        'collect-counters',
        'Collect interface counters',
        'Read the error counters of every interface.',
        'Counters collected',
      ),
      scenarioName: 'a switch with one uplink is reported to NetOps',
    },
    rollout: {
      key: 'ntp-rollout',
      name: 'NTP rollout',
      goal: 'Point the lab switches at the new NTP servers under a change ticket.',
      inputs: {
        ntp_servers: {
          type: 'list',
          description: 'NTP servers to use',
          value: '10.20.0.10, 10.20.0.11',
        },
        timezone: { type: 'string', description: 'Time zone of the site', value: 'UTC' },
        change_ticket: { type: 'string', description: 'Approved change ticket', value: 'CHG-1042' },
      },
      steps: [
        {
          ...step(
            'announce',
            'Announce the change',
            'Say which change runs on each switch.',
            'Change {{ change_ticket }} on {{ inventory_hostname }}',
          ),
          reads: ['change_ticket'],
        },
        {
          ...step(
            'push-ntp',
            'Push the NTP servers',
            'Configure the new NTP servers.',
            'NTP servers {{ ntp_servers | join(", ") }}',
          ),
          reads: ['ntp_servers'],
        },
        {
          ...step(
            'set-timezone',
            'Set the time zone',
            'Configure the time zone of the site.',
            'Time zone {{ timezone }}',
          ),
          reads: ['timezone'],
        },
      ],
    },
    upgrade: {
      key: 'dc-upgrade',
      name: 'Data centre upgrade',
      goal: 'Upgrade a data centre switch pair one switch at a time, with checks before and after.',
      approval: 'Approve the change window',
      approvalIntent: 'The change manager approves the window.',
      midApproval: {
        key: 'approve-upgrade',
        title: 'Approve the upgrade',
        intent: 'The on-call engineer confirms the switch is idle.',
        after: 'drain',
      },
      needsRoot: 'restart-time',
      noRoot: 'drift-report',
      subflows: [
        {
          key: 'precheck',
          title: 'Pre-checks',
          intent: 'Make sure the switch can be upgraded safely.',
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
              key: 'check-ha',
              title: 'Check the HA peer state',
              intent: 'The peer is healthy and in sync.',
              msg: 'HA peer in sync',
            },
            {
              key: 'record-state',
              title: 'Record the pre-upgrade state',
              intent: 'Save interfaces and routes for the comparison.',
              msg: 'State recorded',
            },
          ],
        },
        {
          key: 'drain',
          title: 'Drain the switch',
          intent: 'Move traffic to the peer.',
          steps: [
            {
              key: 'drain-traffic',
              title: 'Drain traffic',
              intent: 'Shift traffic to the HA peer.',
              msg: 'Traffic drained',
            },
            {
              key: 'wait-sessions',
              title: 'Wait for sessions to drop',
              intent: 'Wait until active sessions are below 50.',
            },
            {
              key: 'disable-alerts',
              title: 'Disable alerts',
              intent: 'Silence monitoring for this switch.',
              msg: 'Alerts disabled',
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
              intent: 'Copy the image to the switch.',
              msg: 'Image copied to flash:',
            },
            {
              key: 'verify-checksum',
              title: 'Verify the image checksum',
              intent: 'The checksum matches the release notes.',
              msg: 'Checksum matches',
            },
            {
              key: 'restart-time',
              title: 'Restart the time service',
              intent: 'Restart NTP so the clock is right after the reboot.',
              msg: 'Time service restarted',
              become: true,
            },
            {
              key: 'install-image',
              title: 'Install the image',
              intent: 'Set the boot variable to the new image.',
              msg: 'Image installed',
            },
            {
              key: 'reboot',
              title: 'Reboot the switch',
              intent: 'Reload into the new image.',
              msg: 'Rebooting',
            },
            {
              key: 'wait-device',
              title: 'Wait for the switch',
              intent: 'Wait until SSH answers again.',
            },
          ],
        },
        {
          key: 'verify',
          title: 'Verify the switch',
          intent: 'Compare the switch with its state before the upgrade.',
          steps: [
            {
              key: 'verify-services',
              title: 'Verify services',
              intent: 'Every service runs again.',
              msg: 'Services up',
            },
            {
              key: 'compare-interfaces',
              title: 'Compare interface state',
              intent: 'Interfaces match the recorded state.',
            },
            {
              key: 'drift-report',
              title: 'Write the drift report',
              intent: 'Write what changed into the change ticket.',
              msg: 'Drift report written',
              become: true,
            },
            {
              key: 'all-up',
              title: 'Are all services up?',
              intent: 'Only healthy switches get their traffic back.',
              kind: 'decision',
              condition: "inventory_hostname not in groups.get('degraded', [])",
            },
          ],
        },
        {
          key: 'restore',
          title: 'Restore service',
          intent: 'Give the switch its traffic back.',
          steps: [
            {
              key: 'enable-alerts',
              title: 'Enable alerts',
              intent: 'Turn monitoring back on.',
              msg: 'Alerts enabled',
            },
            {
              key: 'restore-traffic',
              title: 'Restore traffic',
              intent: 'Shift traffic back from the peer.',
              msg: 'Traffic restored',
            },
            {
              key: 'notify-team',
              title: 'Notify the team',
              intent: 'Post the result in the team channel.',
            },
          ],
        },
      ],
    },
    pipeline: {
      key: 'release-pipeline',
      name: 'Release pipeline',
      goal: 'Build and publish the automation collection.',
      section: 'Build stage',
      steps: [
        step('checkout', 'Check out the repository', 'Fetch the tagged commit.', 'Checked out'),
        step('lint', 'Lint', 'ansible-lint finds no errors.', 'Lint passed'),
        step('unit-tests', 'Unit tests', 'The module unit tests pass.', 'Tests passed'),
        step('package', 'Package', 'Build the collection tarball.', 'Packaged'),
        step('publish', 'Publish', 'Upload the tarball to the internal hub.', 'Published'),
        step('notify', 'Notify the channel', 'Post the release in the team channel.', 'Notified'),
      ],
    },
    audit: {
      key: 'firewall-audit',
      name: 'Firewall audit',
      goal: 'Find rules on the lab firewalls that no traffic can reach.',
      steps: [
        step('export-rules', 'Export the rule base', 'Read every rule.', 'Rules exported'),
        step(
          'find-shadowed',
          'Find shadowed rules',
          'List rules hidden by earlier ones.',
          'Shadowed rules listed',
        ),
        step(
          'write-report',
          'Write the audit report',
          'Write the findings to the audit folder.',
          'Report written',
        ),
      ],
    },
    rotation: {
      key: 'backup-rotation',
      name: 'Config backup rotation',
      goal: 'Keep 30 days of configuration backups on the backup server.',
      steps: [
        step(
          'find-old',
          'Find old backups',
          'List backups older than 30 days.',
          'Old backups listed',
        ),
        step('archive', 'Archive the old backups', 'Pack them into one archive.', 'Archived'),
        step(
          'delete-copies',
          'Delete archived copies',
          'Remove the files that are now in the archive.',
          'Copies deleted',
        ),
      ],
      handEdit: { from: 'msg: Archived', to: 'msg: Archived (keep 45 days)' },
    },
    outside: {
      added: {
        ...step(
          'check-bgp',
          'Check BGP sessions',
          'Every BGP session is established on the peer.',
          'BGP sessions established',
        ),
        sub: 'drain',
        after: 'drain/drain-traffic.ok_hosts',
      },
      renamed: {
        node: 'verify/verify-services',
        was: 'Verify services',
        title: 'Verify services and VIPs',
      },
      rebound: {
        node: 'upgrade/copy-image',
        title: 'Copy the image',
        msg: 'Image copied to bootflash:',
      },
    },
  },
  b: {
    repo: 'Campus network automation',
    deviceWord: 'router',
    devicesWord: 'routers',
    hosts: [
      { name: 'lab-rt-11', vars: { os_release: '9.4', power_supplies: '2' } },
      { name: 'lab-rt-12', vars: { os_release: '8.7', power_supplies: '2' } },
      { name: 'lab-rt-13', vars: { os_release: '9.2', power_supplies: '2' } },
      { name: 'lab-rt-14', vars: { os_release: '9.1', power_supplies: '1' } },
    ],
    first: {
      name: 'Collect inventory',
      steps: ['Check the device answers', 'Record serial numbers'],
    },
    baseline: {
      key: 'syslog-baseline',
      name: 'Syslog baseline',
      goal: 'Every router sends its logs to the collectors and shows the message of the day.',
      check: step(
        'check-syslog',
        'Check syslog status',
        'Read the logging hosts and their state.',
        'Logging hosts reachable',
      ),
      draft: {
        key: 'set-motd',
        title: 'Set the message of the day',
        intent: 'Write the standard message of the day.',
      },
      save: step(
        'save-config',
        'Save the configuration',
        'Write the running configuration to startup.',
        'Configuration saved',
      ),
      bind: {
        module: 'ansible.builtin.lineinfile',
        params: { path: '/etc/motd', line: 'Managed by NetOps' },
      },
    },
    health: {
      key: 'campus-health',
      name: 'Campus health check',
      goal: 'Find campus routers that need attention before the next change window.',
      reported: 'Reported to NetOps',
      first: {
        ...step('check-release', 'Check software is supported', 'The release is 9.0 or newer.', ''),
        that: "hostvars[inventory_hostname].os_release is version('9.0', '>=')",
        failMsg: 'Release {{ hostvars[inventory_hostname].os_release }} is older than 9.0',
        fails: 'lab-rt-12',
      },
      second: {
        ...step(
          'check-power',
          'Check power supplies are redundant',
          'The router has two power supplies.',
          '',
        ),
        that: 'hostvars[inventory_hostname].power_supplies | int >= 2',
        failMsg: 'Only {{ hostvars[inventory_hostname].power_supplies }} power supply',
        fails: 'lab-rt-14',
      },
      collect: step(
        'collect-optics',
        'Collect optics levels',
        'Read the light levels of every optic.',
        'Optics read',
      ),
      scenarioName: 'a router with one power supply is reported to NetOps',
    },
    rollout: {
      key: 'syslog-rollout',
      name: 'Syslog rollout',
      goal: 'Point the lab routers at the new log collectors under a change ticket.',
      inputs: {
        syslog_servers: {
          type: 'list',
          description: 'Log collectors to use',
          value: '10.30.0.5, 10.30.0.6',
        },
        facility: { type: 'string', description: 'Syslog facility', value: 'local6' },
        change_ticket: { type: 'string', description: 'Approved change ticket', value: 'CHG-2087' },
      },
      steps: [
        {
          ...step(
            'announce',
            'Announce the change',
            'Say which change runs on each router.',
            'Change {{ change_ticket }} on {{ inventory_hostname }}',
          ),
          reads: ['change_ticket'],
        },
        {
          ...step(
            'push-syslog',
            'Push the log collectors',
            'Configure the new log collectors.',
            'Log collectors {{ syslog_servers | join(", ") }}',
          ),
          reads: ['syslog_servers'],
        },
        {
          ...step(
            'set-facility',
            'Set the facility',
            'Configure the syslog facility.',
            'Facility {{ facility }}',
          ),
          reads: ['facility'],
        },
      ],
    },
    upgrade: {
      key: 'edge-upgrade',
      name: 'Edge router upgrade',
      goal: 'Upgrade an edge router pair one router at a time, with checks before and after.',
      approval: 'Approve the maintenance window',
      approvalIntent: 'The change manager approves the window.',
      midApproval: {
        key: 'approve-reload',
        title: 'Approve the reload',
        intent: 'The on-call engineer confirms the router is idle.',
        after: 'drain',
      },
      needsRoot: 'reload-routing',
      noRoot: 'audit-summary',
      subflows: [
        {
          key: 'precheck',
          title: 'Pre-checks',
          intent: 'Make sure the router can be upgraded safely.',
          steps: [
            {
              key: 'check-flash',
              title: 'Check boot flash space',
              intent: 'At least 2 GB free for the package.',
              msg: 'Flash space checked',
            },
            {
              key: 'check-archive',
              title: 'Check a config archive exists',
              intent: 'An archive from today exists.',
              msg: 'Archive found',
            },
            {
              key: 'check-bfd',
              title: 'Check the BFD peers',
              intent: 'Every BFD session is up.',
              msg: 'BFD peers up',
            },
            {
              key: 'record-routes',
              title: 'Record the routing table',
              intent: 'Save the routes for the comparison.',
              msg: 'Routes recorded',
            },
          ],
        },
        {
          key: 'drain',
          title: 'Drain the router',
          intent: 'Move traffic to the peer router.',
          steps: [
            {
              key: 'shift-traffic',
              title: 'Shift traffic away',
              intent: 'Raise the metrics so traffic moves to the peer.',
              msg: 'Traffic shifted',
            },
            {
              key: 'wait-flows',
              title: 'Wait for flows to drain',
              intent: 'Wait until the interface rate is below 1 Mbit/s.',
            },
            {
              key: 'mute-monitoring',
              title: 'Mute monitoring',
              intent: 'Silence monitoring for this router.',
              msg: 'Monitoring muted',
            },
          ],
        },
        {
          key: 'upgrade',
          title: 'Upgrade the software',
          intent: 'Install the new package and restart.',
          steps: [
            {
              key: 'copy-package',
              title: 'Copy the package',
              intent: 'Copy the package to the router.',
              msg: 'Package copied to harddisk:',
            },
            {
              key: 'verify-hash',
              title: 'Verify the package hash',
              intent: 'The hash matches the release notes.',
              msg: 'Hash matches',
            },
            {
              key: 'reload-routing',
              title: 'Reload the routing daemon',
              intent: 'Reload the daemon so it picks up the new policy.',
              msg: 'Routing daemon reloaded',
              become: true,
            },
            {
              key: 'install-package',
              title: 'Install the package',
              intent: 'Activate the new package.',
              msg: 'Package installed',
            },
            {
              key: 'reload',
              title: 'Reload the router',
              intent: 'Reload into the new package.',
              msg: 'Reloading',
            },
            {
              key: 'wait-router',
              title: 'Wait for the router',
              intent: 'Wait until SSH answers again.',
            },
          ],
        },
        {
          key: 'verify',
          title: 'Verify the router',
          intent: 'Compare the router with its state before the upgrade.',
          steps: [
            {
              key: 'verify-routes',
              title: 'Verify routes',
              intent: 'Every route is back.',
              msg: 'Routes back',
            },
            {
              key: 'compare-prefixes',
              title: 'Compare BGP prefixes',
              intent: 'Prefix counts match the recorded state.',
            },
            {
              key: 'audit-summary',
              title: 'Write the audit summary',
              intent: 'Write what changed into the change ticket.',
              msg: 'Audit summary written',
              become: true,
            },
            {
              key: 'routes-back',
              title: 'Are all routes back?',
              intent: 'Only healthy routers get their traffic back.',
              kind: 'decision',
              condition: "inventory_hostname not in groups.get('degraded', [])",
            },
          ],
        },
        {
          key: 'restore',
          title: 'Restore service',
          intent: 'Give the router its traffic back.',
          steps: [
            {
              key: 'unmute-monitoring',
              title: 'Unmute monitoring',
              intent: 'Turn monitoring back on.',
              msg: 'Monitoring unmuted',
            },
            {
              key: 'restore-traffic',
              title: 'Restore traffic',
              intent: 'Lower the metrics so traffic comes back.',
              msg: 'Traffic restored',
            },
            {
              key: 'tell-noc',
              title: 'Tell the NOC',
              intent: 'Post the result in the NOC channel.',
            },
          ],
        },
      ],
    },
    pipeline: {
      key: 'image-pipeline',
      name: 'Image pipeline',
      goal: 'Build and push the execution environment image.',
      section: 'Build stage',
      steps: [
        step('checkout', 'Check out the repository', 'Fetch the tagged commit.', 'Checked out'),
        step('validate', 'Validate', 'The definition file is valid.', 'Valid'),
        step('scan', 'Scan', 'No critical vulnerabilities.', 'Scan passed'),
        step('build', 'Build', 'Build the image.', 'Built'),
        step('push', 'Push', 'Push the image to the internal registry.', 'Pushed'),
        step('notify', 'Notify the channel', 'Post the release in the team channel.', 'Notified'),
      ],
    },
    audit: {
      key: 'acl-audit',
      name: 'ACL audit',
      goal: 'Find access list entries on the lab routers that no traffic matches.',
      steps: [
        step('export-acls', 'Export the ACLs', 'Read every access list.', 'ACLs exported'),
        step(
          'find-unused',
          'Find unused entries',
          'List entries with zero hits.',
          'Unused entries listed',
        ),
        step(
          'write-report',
          'Write the audit report',
          'Write the findings to the audit folder.',
          'Report written',
        ),
      ],
    },
    rotation: {
      key: 'log-rotation',
      name: 'Log archive rotation',
      goal: 'Keep 90 days of router logs on the log server.',
      steps: [
        step('find-old', 'Find old logs', 'List logs older than 90 days.', 'Old logs listed'),
        step('archive', 'Archive the old logs', 'Pack them into one archive.', 'Archived'),
        step(
          'delete-copies',
          'Delete archived copies',
          'Remove the files that are now in the archive.',
          'Copies deleted',
        ),
      ],
      handEdit: { from: 'msg: Archived', to: 'msg: Archived (keep 120 days)' },
    },
    outside: {
      added: {
        ...step(
          'check-ospf',
          'Check OSPF neighbours',
          'Every OSPF neighbour is full on the peer.',
          'OSPF neighbours full',
        ),
        sub: 'drain',
        after: 'drain/shift-traffic.ok_hosts',
      },
      renamed: {
        node: 'verify/verify-routes',
        was: 'Verify routes',
        title: 'Verify routes and prefixes',
      },
      rebound: {
        node: 'upgrade/copy-package',
        title: 'Copy the package',
        msg: 'Package copied to bootflash:',
      },
    },
  },
};
