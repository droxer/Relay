# Relay web UI image, for hosting the UI as its own service (Railway, or any
# container host) instead of having the backend serve it.
#
# Builds the static export in direct mode: the browser calls the backend origin
# itself (NEXT_PUBLIC_RELAY_API_ORIGIN), so this image runs no Node and proxies
# nothing. The backend must allow this origin in CORS and share its session
# cookie with it. See docs/deployment-cloudflare.md § 8.
#
# Build from the repo root: docker build -f web/Dockerfile .
FROM node:24-bookworm-slim AS build
WORKDIR /build

# Resolve dependencies before copying sources so a code-only change reuses the
# cached install layer.
COPY package.json package-lock.json tsconfig.options.json ./
COPY packages/relay-core/package.json ./packages/relay-core/
COPY web/package.json ./web/
RUN npm ci --include=dev --workspace relay-core --workspace web --include-workspace-root

COPY packages/relay-core/ ./packages/relay-core/
COPY web/ ./web/

# NEXT_PUBLIC_* values are inlined into the bundle at build time, so changing
# one means rebuilding. Railway passes service variables through as build args.
# Without an API origin the export would call /api on this host, which serves
# no API, so refuse to build one.
ARG NEXT_PUBLIC_RELAY_API_ORIGIN
# The public address of this site (e.g. https://get-relay.cc). Optional: only a
# build that sets it is indexable — it gets canonical links, Open Graph tags,
# and a robots.txt that admits crawlers. Left unset, robots.txt disallows all.
ARG NEXT_PUBLIC_RELAY_SITE_URL=""
RUN test -n "$NEXT_PUBLIC_RELAY_API_ORIGIN" \
    || { echo "NEXT_PUBLIC_RELAY_API_ORIGIN is required (e.g. https://api.example.com)" >&2; exit 1; }
ENV NEXT_PUBLIC_RELAY_API_ORIGIN=$NEXT_PUBLIC_RELAY_API_ORIGIN \
    NEXT_PUBLIC_RELAY_SITE_URL=$NEXT_PUBLIC_RELAY_SITE_URL \
    NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w web

FROM caddy:2-alpine
# The Caddyfile redirects /install.sh to the API origin baked into the bundle.
ARG NEXT_PUBLIC_RELAY_API_ORIGIN
ENV RELAY_API_ORIGIN=$NEXT_PUBLIC_RELAY_API_ORIGIN
COPY web/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /build/web/out /srv
