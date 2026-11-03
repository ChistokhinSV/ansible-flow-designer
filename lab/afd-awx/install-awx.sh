#!/usr/bin/env bash
# Single-node k3s + AWX (awx-operator) on afd-awx (AFD-76), from the 119 project's ops1 recipe.
# Idempotent: safe to re-run. Usage on the VM, as ubuntu (needs sudo): bash install-awx.sh
set -euo pipefail

K3S_VERSION="${K3S_VERSION:-v1.31.14+k3s1}"        # pinned: awx-operator 2.19.1 is from 2024, keep k8s conservative
AWX_OPERATOR_VERSION="${AWX_OPERATOR_VERSION:-2.19.1}"
NS=awx
WORKDIR="$HOME/awx"
HERE="$(cd "$(dirname "$0")" && pwd)"

log() { printf '[%s] %s\n' "$(date '+%H:%M:%S %d.%m.%Y')" "$*"; }

if ! command -v k3s >/dev/null 2>&1; then
    log "installing k3s ${K3S_VERSION}"
    # traefik not needed: AWX is exposed as NodePort
    curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="$K3S_VERSION" sh -s - \
        --write-kubeconfig-mode 644 --disable traefik
fi
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# right after install the node object may not exist yet; `kubectl wait` fails on "no matching resources"
for _ in $(seq 1 60); do
    kubectl get nodes 2>/dev/null | grep -q ' Ready' && break
    sleep 5
done
kubectl wait --for=condition=Ready node --all --timeout=300s

mkdir -p "$WORKDIR"
cat > "$WORKDIR/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - github.com/ansible/awx-operator/config/default?ref=${AWX_OPERATOR_VERSION}
images:
  - name: quay.io/ansible/awx-operator
    newTag: ${AWX_OPERATOR_VERSION}
  # gcr.io/kubebuilder/kube-rbac-proxy was removed from gcr.io; operator pod hangs without this override
  - name: gcr.io/kubebuilder/kube-rbac-proxy
    newName: quay.io/brancz/kube-rbac-proxy
    newTag: v0.15.0
namespace: ${NS}
EOF

# Two phases: the AWX CRD must exist before the AWX resource can be applied.
log "deploying awx-operator ${AWX_OPERATOR_VERSION}"
kubectl apply -k "$WORKDIR"
kubectl -n "$NS" rollout status deployment/awx-operator-controller-manager --timeout=600s

log "creating AWX instance"
kubectl apply -f "$HERE/awx.yaml"

log "waiting for AWX web (first start pulls images and migrates DB, ~10 min)"
for _ in $(seq 1 120); do
    if kubectl -n "$NS" get deployment awx-web >/dev/null 2>&1; then
        kubectl -n "$NS" rollout status deployment/awx-web --timeout=900s && break
    fi
    sleep 10
done
# The first start migrates the database before the task pod runs: give it the time it takes.
kubectl -n "$NS" rollout status deployment/awx-task --timeout=1800s

log "AWX ready: http://<afd-awx>:30080, user admin; the password is in the secret awx-admin-password"
log "DONE"
