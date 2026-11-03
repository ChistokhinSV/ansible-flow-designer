#!/bin/sh
# Clock of ops1 after the Windows host sleeps: the VM is paused, so its clock falls behind by the
# sleep time, and systemd-timesyncd still says "synchronized" until its next poll (up to 34 min by
# default). Wrong AWX job times and token checks follow. Polling at most every 2 min fixes the clock
# within 2 min of a wake (a large offset is stepped, not slewed).
# Run on ops1 as the ubuntu user: sh ops1-timesync.sh
set -eu

sudo mkdir -p /etc/systemd/timesyncd.conf.d
sudo tee /etc/systemd/timesyncd.conf.d/afd-lab.conf >/dev/null <<EOF
[Time]
PollIntervalMaxSec=120
EOF
sudo systemctl restart systemd-timesyncd
timedatectl show-timesync -p PollIntervalMaxUSec -p ServerName
