#!/bin/sh
# Runs every scenario inside one probe image, with this folder mounted read-only at /work:
#   docker run --rm -v "$PWD:/work:ro" ps-probe-env:2.19 sh /work/run.sh
cd /work || exit 1
export ANSIBLE_STDOUT_CALLBACK=ansible.posix.json ANSIBLE_ROLES_PATH=/work/roles
export ANSIBLE_DEPRECATION_WARNINGS=0 ANSIBLE_LOCALHOST_WARNING=0 ANSIBLE_HOST_KEY_CHECKING=0
ansible --version | head -1
for pb in s*.yml; do
  case "$pb" in *_inner.yml) continue ;; esac
  for mode in run check; do
    flag=""
    if [ "$mode" = check ]; then
      case "$pb" in s06*|s07*|s10*) flag="--check" ;; *) continue ;; esac
    fi
    ansible-playbook -i inventory.ini $flag -e '{"devices": ["sw-edge-01", "sw-edge-02", "sw-ghost-09"]}' \
      "$pb" > /tmp/out.json 2> /tmp/err.txt
    echo "== $pb ($mode) rc=$?"
    python3 report.py /tmp/out.json
    grep -iE "warn|error" /tmp/err.txt | grep -vi deprecat | head -3 | sed 's/^/  stderr: /'
  done
done
