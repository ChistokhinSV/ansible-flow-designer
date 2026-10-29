# Lab: AWX and Docker suites in GNS3 (M7)

Run mode is tested against a real AWX in the GNS3 lab (ADR-0013). Everything here is lab-only: fictional hosts, no production data.

## Pieces

| What                                                                  | Where                                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| AWX 24.6.1 on k3s (awx-operator 2.19.1), NodePort 30080               | `ops1` in the GNS3 project `snow_AWX` (management network `10.10.10.0/24`, ops1 `10.10.10.10`) |
| Git server for the AWX project (`git daemon`, port 9418, `/srv/git`)  | `ops1`, set up by `lab/ops1-git-daemon.sh`                                                     |
| `afd-awx-ee:2.19` (ansible-core 2.19 + ansible-runner)                | built with `just awx-ee-build`, imported into k3s                                              |
| EE, project `AFD lab` and inventory `AFD lab`                         | `just awx-lab [--sync]`                                                                        |
| Import fixtures (M9): `AFD fixture ·` job templates and two workflows | `just awx-lab --fixtures`; `--record-import test/fixtures/awx/import/api.json` re-records      |
| Docker suites                                                         | `just test-docker-lab` (throwaway container on the GNS3 VM)                                    |

The inventory `AFD lab` holds fictional hosts: `h01`–`h06` and `sw-edge-01`–`04` use the local connection; `h07` points at `127.0.0.1:1` and is always unreachable.

## Setup

1. Start the `snow_AWX` project and `ops1` (GNS3 MCP), then wait for AWX to answer.
2. Tunnel the NodePort to Windows (keep it running):

   ```bash
   ssh -N -J gns3 -i ~/.ssh/fwup_lab -L 127.0.0.1:30080:localhost:30080 ubuntu@192.168.122.72
   ```

3. Git server on ops1 (once):

   ```bash
   ssh -J gns3 -i ~/.ssh/fwup_lab ubuntu@192.168.122.72 'sh -s' < lab/ops1-git-daemon.sh
   ```

4. The EE image, built on the GNS3 VM's Docker engine and imported into k3s (Docker Desktop is off while GNS3 runs):

   ```bash
   DOCKER_HOST=ssh://gns3 just awx-ee-build 2.19
   ```

   ```bash
   DOCKER_HOST=ssh://gns3 docker save afd-awx-ee:2.19 | ssh -J gns3 -i ~/.ssh/fwup_lab ubuntu@192.168.122.72 'sudo k3s ctr -n k8s.io images import -'
   ```

5. A personal access token for an AWX user with write access (AWX → Users → Tokens) goes into the gitignored `.env` together with the lab Git remote:

   ```ini
   AFD_AWX_URL=http://127.0.0.1:30080
   AFD_AWX_TOKEN=<token>
   AFD_AWX_GIT_REMOTE=ssh://ubuntu@192.168.122.72/srv/git/afd-lab.git
   AFD_AWX_GIT_SSH=ssh -o BatchMode=yes -J gns3 -i ~/.ssh/fwup_lab
   ```

6. AWX objects:

   ```bash
   just awx-lab --sync
   ```

## Tests

- `just test-awx`: the M7 suite in VS Code. It pushes the test workspace to the lab remote (force, `main`), checks the token, sets up `AFD · awx-e2e`, runs one failing and one passing job, and checks Run mode and the tested proposal. It is skipped without `AFD_AWX_URL` and `AFD_AWX_TOKEN`.
- `just test-docker-lab [engine] [probe] [integration]`: copies the working tree to `/tmp/afd-ci-<stamp>` on the GNS3 VM. Missing `afd-ee:2.19/2.20/2.21` images are built there. The suites run in a throwaway `node:24-bookworm` container with the VM's Docker socket, and the folder is removed afterwards.

## In VS Code

```json
{
  "afd.awx.url": "http://127.0.0.1:30080"
}
```

Then _Ansible Flow: Set AWX Token_, _Set Up AWX Template_ (project `AFD lab`, inventory `AFD lab`, EE `AFD EE (ansible-core 2.19)`), commit and push the flow to the lab remote, and _Launch in AWX_.
