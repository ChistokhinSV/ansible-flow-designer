# AWX execution environment for Run mode (M7, ADR-0013): afd-ee plus ansible-runner, which AWX job
# pods run as "ansible-runner worker". Build after afd-ee: just awx-ee-build 2.19
# (without local Docker, point DOCKER_HOST at a remote engine: DOCKER_HOST=ssh://host just awx-ee-build 2.19).
ARG CORE=2.19
FROM afd-ee:${CORE}

ARG RUNNER=2.4.3
USER root
# AWX runs the pod as uid 1000 with group 0 and writes the job's private data to /runner.
RUN pip install --no-cache-dir "ansible-runner==${RUNNER}" \
    && mkdir -p /runner \
    && chown 1000:0 /runner /home/ansible \
    && chmod 775 /runner /home/ansible
USER 1000
ENV HOME=/home/ansible
WORKDIR /runner
CMD ["ansible-runner", "--version"]
