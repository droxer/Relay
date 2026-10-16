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
COPY tools/vendor/braces/ ./tools/vendor/braces/
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

# pg_dump/pg_restore for `relay backup-database` (a cron service on the same
# image). pg_dump must be at least the server's major version, so the client
# comes from the PostgreSQL apt repository; set PG_CLIENT_MAJOR to match the
# database (Railway passes service variables through as build args).
ARG PG_CLIENT_MAJOR=18
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && install -d /usr/share/postgresql-common/pgdg \
    && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
        https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" \
        > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends "postgresql-client-${PG_CLIENT_MAJOR}" \
    && apt-get purge -y curl \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Resolve dependencies before copying sources so a code-only change reuses the
# cached dependency layer. The migration extra carries Alembic without shipping
# test and pre-commit tooling in the runtime image.
# Railway cache-mount IDs must contain a literal service ID. Keep this image
# portable across projects and backup services by using Docker layer caching.
COPY backend/pyproject.toml backend/uv.lock ./backend/
RUN uv sync --project backend --extra migration --extra r2 --frozen --no-install-project

COPY backend/ ./backend/
COPY --from=computer-client /build/backend/relay/computer/daemon.tar.gz ./backend/relay/computer/daemon.tar.gz
RUN uv sync --project backend --extra migration --extra r2 --frozen

# Bind every interface: the platform routes to the container's published port,
# which arrives as $PORT and is read by relay.core.deploy_config.
ENV HOST=0.0.0.0 \
    RELAY_STORAGE=postgres \
    RELAY_AUTH_STORE=database \
    RELAY_DAEMON_STORE=database \
    RELAY_CHAT_STORE=database \
    RELAY_DATA_DIR=/data

# With the database stores above, everything but skill bundles lives in
# Postgres. Skill bundles are written under /data/skills/objects unless
# RELAY_BLOB_STORE=r2, so mount a volume at /data when R2 is not configured.
RUN useradd --system --uid 10001 --user-group --home-dir /nonexistent --shell /usr/sbin/nologin relay \
    && mkdir -p /data \
    && chown -R relay:relay /data

USER relay

EXPOSE 8790

CMD ["relay"]
