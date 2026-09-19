# Relay control plane image (Railway, or any container host).
#
# The runtime image contains the backend and a downloadable client archive, with no agent CLIs or
# BoxLite runtime: the backend never executes agents — it queues work for daemons, which
# run on machines that own a sandbox. See docs/deployment.md.
# Compile the downloadable personal-computer client; it is data in the final image.
FROM node:24-bookworm-slim AS computer-client
WORKDIR /build
COPY package.json package-lock.json tsconfig.options.json ./
COPY packages/relay-core/ ./packages/relay-core/
COPY packages/relay-daemon/ ./packages/relay-daemon/
COPY tools/build-computer.mjs ./tools/build-computer.mjs
RUN npm ci --ignore-scripts --include=dev --workspace relay-core --workspace relay-daemon --include-workspace-root \
    && npm run build:computer

FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/relay-venv \
    PATH="/opt/relay-venv/bin:$PATH"

WORKDIR /app

# Resolve dependencies before copying sources so a code-only change reuses the
# cached dependency layer. The migration extra carries Alembic without shipping
# test and pre-commit tooling in the runtime image.
COPY backend/pyproject.toml backend/uv.lock ./backend/
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --project backend --extra migration --frozen --no-install-project

COPY backend/ ./backend/
COPY --from=computer-client /build/backend/relay/computer/daemon.tar.gz ./backend/relay/computer/daemon.tar.gz
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --project backend --extra migration --frozen

# Bind every interface: the platform routes to the container's published port,
# which arrives as $PORT and is read by relay.core.deploy_config.
ENV HOST=0.0.0.0 \
    RELAY_STORAGE=postgres \
    RELAY_AUTH_STORE=database \
    RELAY_DAEMON_STORE=database \
    RELAY_CHAT_STORE=database \
    RELAY_DATA_DIR=/data

# Operational state that is not in Postgres (profile images, managed-node
# records) lives here. Mount a volume at /data to keep it across deploys.
RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin relay \
    && mkdir -p /data \
    && chown -R relay:relay /data

USER relay

EXPOSE 8790

CMD ["relay"]
