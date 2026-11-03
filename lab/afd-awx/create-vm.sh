#!/usr/bin/env bash
# AFD's own AWX VM (AFD-76): the Ubuntu 24.04 server cloud image in VMware Workstation, bridged on
# the LAN with DHCP, the lab SSH key through cloud-init (VMware guestinfo). Outside GNS3, so AWX
# runs while Hyper-V is on (WSL 2) and GNS3's nested KVM is not. Run in Git Bash on the Windows host:
#   bash lab/afd-awx/create-vm.sh <noble-server-cloudimg-amd64.ova> [parent-dir]   (default F:\VMs)
# Creates <parent>/afd-awx/afd-awx.vmx, starts it and prints its address. Safe to re-run.
set -euo pipefail

OVA=${1:?the Ubuntu 24.04 server cloud image (.ova)}
PARENT=${2:-/f/VMs}
NAME=afd-awx
VMW="/c/Program Files (x86)/VMware/VMware Workstation"
KEY=${AFD_LAB_KEY:-$HOME/.ssh/fwup_lab.pub}
VMX="$PARENT/$NAME/$NAME.vmx"
CPUS=${AFD_AWX_CPUS:-4}
MEMORY_MB=${AFD_AWX_MEMORY_MB:-8192}
DISK=${AFD_AWX_DISK:-40GB}

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S %d.%m.%Y')" "$*"; }
vmrun() { "$VMW/vmrun.exe" -T ws "$@"; }

if [ ! -e "$VMX" ]; then
  log "converting $(basename "$OVA") into $PARENT/$NAME"
  "$VMW/OVFTool/ovftool.exe" --acceptAllEulas --allowExtraConfig --name="$NAME" \
    "$(cygpath -w "$OVA")" "$(cygpath -w "$PARENT")"
  # Size, network and first-boot settings; cloud-init reads guestinfo.* (DataSourceVMware).
  sed -i -E '/^(numvcpus|memsize|ethernet0\.connectionType|guestinfo\.(user|meta)data(\.encoding)?) =/d' "$VMX"
  meta=$(printf 'instance-id: %s-1\nlocal-hostname: %s\n' "$NAME" "$NAME" | base64 -w0)
  user=$(printf '#cloud-config\nhostname: %s\nusers:\n  - name: ubuntu\n    sudo: ALL=(ALL) NOPASSWD:ALL\n    shell: /bin/bash\n    ssh_authorized_keys:\n      - %s\npackage_update: true\npackages: [open-vm-tools, git]\ngrowpart: {mode: auto, devices: ["/"]}\n' \
    "$NAME" "$(cat "$KEY")" | base64 -w0)
  {
    echo "numvcpus = \"$CPUS\""
    echo "memsize = \"$MEMORY_MB\""
    echo 'ethernet0.connectionType = "bridged"'
    echo "guestinfo.metadata = \"$meta\""
    echo 'guestinfo.metadata.encoding = "base64"'
    echo "guestinfo.userdata = \"$user\""
    echo 'guestinfo.userdata.encoding = "base64"'
  } >> "$VMX"
  disk=$(sed -n -E 's/^scsi0:0\.fileName = "(.*)"/\1/p' "$VMX")
  log "growing $disk to $DISK"
  "$VMW/vmware-vdiskmanager.exe" -x "$DISK" "$(cygpath -w "$PARENT/$NAME/$disk")"
fi

if ! vmrun list | grep -qi "$NAME.vmx"; then
  log "starting $NAME"
  vmrun start "$(cygpath -w "$VMX")" nogui
fi
log "waiting for its address (open-vm-tools comes with the first boot)"
ip=$(vmrun getGuestIPAddress "$(cygpath -w "$VMX")" -wait)
log "$NAME is at $ip: ssh -i ${KEY%.pub} ubuntu@$ip"
