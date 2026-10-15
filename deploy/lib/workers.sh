# The web UI on Cloudflare Workers static assets (WEB_HOSTING=workers): the
# export is served from every Cloudflare location instead of one Railway
# region. See deployment-cloudflare.md § 8.

workers_enabled() {
  [ "$WEB_HOSTING" = workers ]
}

# workers_build_export <dest-dir>. Builds the static export of the release
# commit inside Docker, from web/Dockerfile's build stage, so the remote
# source never runs on this machine — the same isolation Railway's builder
# gives the backend. Nothing from the working tree is used.
workers_build_export() (
  set -euo pipefail
  require_cmd git docker
  local dest=$1 temporary image container
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"; [ -z "${container:-}" ] || docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
  git init --bare --quiet "$temporary/source.git"
  GIT_TERMINAL_PROMPT=0 git --git-dir="$temporary/source.git" fetch --quiet --depth=1 \
    "https://github.com/$GITHUB_REPO.git" "$RELEASE_COMMIT" \
    || die "cannot fetch release source $RELEASE_COMMIT; check Git credentials and repository access"
  git --git-dir="$temporary/source.git" archive --format=tar "$RELEASE_COMMIT" \
    | docker build --quiet -f web/Dockerfile --target build \
      --build-arg "NEXT_PUBLIC_RELAY_API_ORIGIN=$API_ORIGIN" \
      --iidfile "$temporary/image" - >&2 \
    || die "web export build failed for $RELEASE_COMMIT"
  image=$(cat "$temporary/image")
  container=$(docker create "$image")
  docker cp "$container:/build/web/out" "$dest" >&2 || die "could not copy the web export out of $image"
  [ -f "$dest/index.html" ] || die "the web export for $RELEASE_COMMIT has no index.html"
)

# workers_publish <zone-id> <export-dir>. Uploads the export, then routes the
# web host to the Worker. The route comes second, so a first deploy never
# points traffic at a Worker that does not exist yet.
workers_publish() {
  local zone=$1 dir=$2 account
  account=$(cf_zone_account_id)
  CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN python3 "$DEPLOY_DIR/workers_deploy.py" \
    --api-url "$CLOUDFLARE_API_URL" --account "$account" --script "$WORKERS_SCRIPT" \
    --assets "$dir" --worker "$DEPLOY_DIR/workers/worker.js" --headers "$DEPLOY_DIR/workers/_headers" \
    || die "publishing Worker $WORKERS_SCRIPT failed"
  cf_ensure_worker_route "$zone" "$WEB_DOMAIN/*" "$WORKERS_SCRIPT"
}
