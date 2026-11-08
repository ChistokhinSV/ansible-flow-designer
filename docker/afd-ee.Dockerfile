# Minimal execution environment for the probe, engine tests and skeleton runs (ADR-0005).
# Build: just ee-build 2.19   (tags afd-ee:2.19; ANSIBLE_CORE picks the newest 2.19.x)
# Not an AWX EE: no receptor or ansible-runner, just ansible-core, a few collections and ssh.
# AFD-161: the base image and the collections are pinned, so a rebuild gets what was tested.
# Move them on together (Docker Hub digest of the tag, Galaxy versions) and run the engine suite.
ARG BASE=python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
FROM ${BASE}

ARG ANSIBLE_CORE=2.19
ARG COLLECTIONS="ansible.netcommon:==8.7.1 ansible.utils:==6.1.1 cisco.ios:==11.6.0"

RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client sshpass git \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir "ansible-core==${ANSIBLE_CORE}.*" \
    && ansible-galaxy collection install --collections-path /usr/share/ansible/collections ${COLLECTIONS} \
    && useradd --create-home --uid 1000 ansible

USER ansible
WORKDIR /work
# /usr/share/ansible/collections is on Ansible's default collections path; no ANSIBLE_COLLECTIONS_PATH
# here, because the environment variable would override collections_path in a repository's ansible.cfg.
# AFD-161: SSH host keys are checked, as Ansible does by default; this image used to turn that off
# (ANSIBLE_HOST_KEY_CHECKING=False), so a run accepted any host key and could hand device
# credentials to whoever answered. A lab sets host_key_checking = False in its own ansible.cfg.
CMD ["ansible", "--version"]
