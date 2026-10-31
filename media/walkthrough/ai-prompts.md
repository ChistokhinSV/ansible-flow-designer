# Ask for a flow

Name the outcome, the levels and what happens on failure. For example:

> Create an Ansible flow `flows/firewall-upgrade/firewall-upgrade.flow.yaml` for a firewall
> firmware upgrade: pre-checks, a configuration backup, an approval, the upgrade, post-checks.
> Put the details of each phase in a subflow. Failed hosts in the upgrade or post-checks roll back
> from the backup; hosts that fail the pre-checks are excluded and reported.

> Add a step after `precheck` that checks NTP, and handle its failures.

> The upgrade step should poll the status API every 15 seconds, up to 10 minutes, until the device
> reports the target version.

> Fix the problems in this flow without changing what it does.

The agent edits by key with all-or-nothing batches. It never writes IDs, and it reads the
problems after each edit.
