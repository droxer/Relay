# Relay cloud computer image: one Fly Machine per managed computer
# (relay-supervisor's "fly-machines" provider; see docs/deployment.md).
#
# The machine is the sandbox, so the daemon runs agents directly in it
# (sandboxMode "none") with the same agent CLIs the BoxLite devbox ships.
# Build from the repository root with `make cloud-computer-image`.

# The devbox image (repository-root `dockerfile`): Node, git, the pinned agent
# CLIs, and the `agent` user. A FROM argument must be declared before any stage.
ARG CLOUD_COMPUTER_BASE_IMAGE=relay-devbox:amd64

# The packaged client — the same bundle `relay update` installs.
FROM node:24-bookworm-slim AS computer-client
WORKDIR /build
COPY package.json package-lock.json tsconfig.options.json ./
COPY packages/relay-core/ ./packages/relay-core/
COPY packages/relay-daemon/ ./packages/relay-daemon/
COPY tools/build-computer.mjs ./tools/build-computer.mjs
COPY tools/vendor/braces/ ./tools/vendor/braces/
RUN npm ci --ignore-scripts --include=dev --workspace relay-core --workspace relay-daemon --include-workspace-root \
    && npm run build:computer \
    && mkdir -p /opt/relay \
    && tar -xzf backend/relay/computer/daemon.tar.gz -C /opt/relay

# The devbox image (declared above): one source for agent CLI versions in both runtimes.
FROM ${CLOUD_COMPUTER_BASE_IMAGE}

COPY --from=computer-client /opt/relay /opt/relay
COPY deploy/cloud-computer/entrypoint.sh /usr/local/bin/relay-cloud-computer
RUN chmod 0755 /usr/local/bin/relay-cloud-computer

# The provider mounts the computer's volume here; everything durable lives on it.
VOLUME /data
ENTRYPOINT ["/usr/local/bin/relay-cloud-computer"]
