#!/usr/bin/env bash
# The Docker suites inside a throwaway container on the GNS3 VM (decision M7-4): engine contract
# tests and probe contract tests in each afd-ee image, then the integration tests with Docker runs
# (AFD_TEST_IMAGE) under Xvfb. The VM's Docker socket is shared and /tmp is the same path on both
# sides, so the bind mounts the tests make resolve on the VM.
# Env: AFD_IMAGES (comma-separated, default afd-ee:2.19,afd-ee:2.20,afd-ee:2.21), AFD_SUITES
# (default "engine probe integration").
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
IMAGES="${AFD_IMAGES:-afd-ee:2.19,afd-ee:2.20,afd-ee:2.21}"
SUITES="${AFD_SUITES:-engine probe integration}"
DOCKER_CLI=29.2.1
UV=0.11.28

log() { printf '[%s] %s\n' "$(date +'%H:%M:%S %d.%m.%Y')" "$*"; }

if [ "${1:-}" != "--as-user" ]; then
  log "Installing tools (docker CLI $DOCKER_CLI, uv $UV, Xvfb and Electron libraries)"
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl git python3 xvfb xauth \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libgtk-3-0 libgbm1 libasound2 libxss1 libsecret-1-0 \
    libxkbfile1 libdrm2 libxshmfence1 >/dev/null
  curl -fsSL "https://download.docker.com/linux/static/stable/x86_64/docker-${DOCKER_CLI}.tgz" |
    tar -xz -C /usr/local/bin --strip-components=1 docker/docker
  curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV}/uv-x86_64-unknown-linux-gnu.tar.gz" |
    tar -xz -C /usr/local/bin --strip-components=1
  # The suites run as uid 1000 (the VM user, and the EE images' ansible user): mkdtemp folders are
  # 0700, so sibling containers can only read them under the same uid.
  exec setpriv --reuid=1000 --regid=1000 --groups="$(stat -c %g /var/run/docker.sock)" \
    env HOME=/home/node bash "$0" --as-user
fi
docker version --format 'docker {{.Client.Version}} -> engine {{.Server.Version}}'

log "npm ci"
npm ci --no-audit --no-fund --loglevel=error

status=0
for suite in $SUITES; do
  case "$suite" in
    engine)
      log "Engine contract tests on $IMAGES"
      AFD_ENGINE=1 AFD_ENGINE_IMAGES="$IMAGES" npx --no-install vitest run --project engine || status=1
      ;;
    probe)
      log "Probe contract tests on $IMAGES"
      (cd probe && AFD_PROBE_IMAGES="$IMAGES" uv run --quiet pytest -q) || status=1
      ;;
    integration)
      image="${IMAGES%%,*}"
      log "Integration tests with Docker runs in $image"
      node scripts/build.mjs --production
      node scripts/build.mjs --tests
      AFD_TEST_IMAGE="$image" AFD_TEST_NO_SANDBOX=1 xvfb-run -a npx --no-install vscode-test --label integration || status=1
      ;;
    *) log "Unknown suite: $suite"; status=1 ;;
  esac
done
log "Done (status $status)"
exit "$status"
