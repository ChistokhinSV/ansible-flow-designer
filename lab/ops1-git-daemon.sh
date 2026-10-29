#!/bin/sh
# Lab Git server for AWX projects (M7, decision M7-2): bare repositories under /srv/git on ops1,
# served read-only over git:// (port 9418) to the AWX pods; pushes go in over SSH.
# Run on ops1 as the ubuntu user: sh ops1-git-daemon.sh [repo ...]   (default: afd-lab)
set -eu

sudo mkdir -p /srv/git
sudo chown "$(id -un):$(id -gn)" /srv/git
for repo in "${@:-afd-lab}"; do
  [ -d "/srv/git/$repo.git" ] || git init --bare --initial-branch=main "/srv/git/$repo.git"
done

sudo tee /etc/systemd/system/afd-git-daemon.service >/dev/null <<EOF
[Unit]
Description=git daemon for Ansible Flow Designer lab repositories (read-only git://)
After=network-online.target

[Service]
User=$(id -un)
ExecStart=/usr/bin/git daemon --reuseaddr --export-all --base-path=/srv/git /srv/git
Restart=always

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now afd-git-daemon
systemctl is-active afd-git-daemon
