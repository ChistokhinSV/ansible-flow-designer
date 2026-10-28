# Minimal execution environment for the probe, engine tests and skeleton runs (ADR-0005).
# Build: just ee-build 2.19   (tags afd-ee:2.19; ANSIBLE_CORE picks the newest 2.19.x)
# Not an AWX EE: no receptor or ansible-runner, just ansible-core, a few collections and ssh.
ARG PYTHON=3.13
FROM python:${PYTHON}-slim

ARG ANSIBLE_CORE=2.19
ARG COLLECTIONS="ansible.netcommon ansible.utils cisco.ios"

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
ENV ANSIBLE_HOST_KEY_CHECKING=False
CMD ["ansible", "--version"]
