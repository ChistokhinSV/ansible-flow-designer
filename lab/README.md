# Lab: AWX and Docker suites (M7)

Run mode is tested against a real AWX (ADR-0013). Everything here is lab-only: fictional hosts, no production data.

Since AFD-76 the AWX is its own VMware Workstation VM, `afd-awx`, outside GNS3. AWX needs no nested virtualization (k3s runs containers), so it keeps running while Hyper-V is on for WSL 2, when GNS3's KVM nodes cannot start. `ops1` in the GNS3 project `snow_AWX` stays as it is for the FortiGate work of the 119 project.

## Pieces

| What                                                                  | Where                                                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| AWX 24.6.1 on k3s v1.31 (awx-operator 2.19.1), NodePort 30080         | the VM `afd-awx` (Ubuntu 24.04, 4 vCPU, 8 GB, bridged on the LAN with DHCP)               |
| Git server for the AWX project (`git daemon`, port 9418, `/srv/git`)  | `afd-awx`, set up by `lab/ops1-git-daemon.sh`                                             |
| Clock sync after the PC sleeps (`PollIntervalMaxSec=120`)             | `afd-awx`, set up by `lab/ops1-timesync.sh`                                               |
| `afd-awx-ee:2.19` (ansible-core 2.19 + ansible-runner)                | built with `just awx-ee-build` on the GNS3 VM's Docker engine, imported into k3s          |
| EE, project `AFD lab` and inventory `AFD lab`                         | `just awx-lab [--sync]`                                                                   |
| Import fixtures (M9): `AFD fixture ·` job templates and two workflows | `just awx-lab --fixtures`; `--record-import test/fixtures/awx/import/api.json` re-records |
| Docker suites                                                         | `just test-docker-lab` (throwaway container on the GNS3 VM)                               |

The inventory `AFD lab` holds fictional hosts: `h01`–`h06` and `sw-edge-01`–`04` use the local connection; `h07` points at `127.0.0.1:1` and is always unreachable.

## Setup

All commands run in Git Bash on the Windows host, from the repository root.

1. The VM, from the Ubuntu 24.04 server cloud image (`noble-server-cloudimg-amd64.ova` from cloud-images.ubuntu.com; check it against `SHA256SUMS`). It goes to `F:\VMs\afd-awx`, gets the lab SSH key through cloud-init and prints its address:

   ```bash
   bash lab/afd-awx/create-vm.sh /c/DOWNLOADS_TEMP/afd-awx/noble-server-cloudimg-amd64.ova
   ```

   Give its MAC address (`ethernet0.generatedAddress` in `afd-awx.vmx`) a DHCP reservation in the router, so the address stays the same. The examples below use `192.168.0.152`.

2. k3s and AWX, the Git server and clock sync (the first start pulls images and migrates the database, about 15 minutes):

   ```bash
   ssh -i ~/.ssh/fwup_lab ubuntu@192.168.0.152 'mkdir -p afd-lab' && scp -i ~/.ssh/fwup_lab lab/afd-awx/install-awx.sh lab/afd-awx/awx.yaml lab/ops1-git-daemon.sh lab/ops1-timesync.sh ubuntu@192.168.0.152:afd-lab/
   ```

   ```bash
   ssh -i ~/.ssh/fwup_lab ubuntu@192.168.0.152 'sh afd-lab/ops1-timesync.sh && sh afd-lab/ops1-git-daemon.sh && bash afd-lab/install-awx.sh'
   ```

3. The EE image, built on the GNS3 VM's Docker engine and imported into k3s:

   ```bash
   DOCKER_HOST=ssh://gns3 just awx-ee-build 2.19
   ```

   ```bash
   DOCKER_HOST=ssh://gns3 docker save afd-awx-ee:2.19 | ssh -i ~/.ssh/fwup_lab ubuntu@192.168.0.152 'sudo k3s ctr -n k8s.io images import -'
   ```

4. Sign in to `http://192.168.0.152:30080` as `admin` (the password is in the Kubernetes secret `awx-admin-password` on the VM). Create a personal access token with write access (Users → admin → Tokens) and put it into the gitignored `.env` with the address and the lab Git remote:

   ```ini
   AFD_AWX_URL=http://192.168.0.152:30080
   AFD_AWX_TOKEN=<token>
   AFD_AWX_GIT_REMOTE=ssh://ubuntu@192.168.0.152/srv/git/afd-lab.git
   AFD_AWX_GIT_SSH=ssh -o BatchMode=yes -i ~/.ssh/fwup_lab
   ```

   The AWX project reads the Git server at the AWX host (`git://192.168.0.152/afd-lab.git`); `AFD_AWX_GIT_URL` names another one.

5. AWX objects:

   ```bash
   just awx-lab --sync
   ```

   ```bash
   just awx-lab --fixtures
   ```

## Tests

- `just test-awx`: the M7 suite in VS Code. It pushes the test workspace to the lab remote (force, `main`), checks the token, sets up `AFD · awx-e2e`, runs one failing and one passing job, and checks Run mode and the tested proposal. It is skipped without `AFD_AWX_URL` and `AFD_AWX_TOKEN`.
- `just test-docker-lab [engine] [probe] [integration]`: copies the working tree to `/tmp/afd-ci-<stamp>` on the GNS3 VM. Missing `afd-ee:2.19/2.20/2.21` images are built there. The suites run in a throwaway `node:24-bookworm` container with the VM's Docker socket, and the folder is removed afterwards.

## In VS Code

```json
{
  "afd.awx.url": "http://192.168.0.152:30080"
}
```

Then _Ansible Flow: Set AWX Token_, _Set Up AWX Template_ (project `AFD lab`, inventory `AFD lab`, EE `AFD EE (ansible-core 2.19)`), commit and push the flow to the lab remote, and _Launch in AWX_.
