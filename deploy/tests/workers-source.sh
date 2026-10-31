#!/usr/bin/env bash
set -euo pipefail
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
. "$TESTS_DIR/../lib/common.sh"
. "$TESTS_DIR/../lib/workers.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/source/deploy/workers" "$WORK/tools"
printf 'selected worker' > "$WORK/source/deploy/workers/worker.js"
printf 'selected headers' > "$WORK/source/deploy/workers/_headers"
git -C "$WORK/source" init -q
git -C "$WORK/source" add .
git -C "$WORK/source" -c user.name=Test -c user.email=test@example.invalid commit -qm selected
RELEASE_COMMIT=$(git -C "$WORK/source" rev-parse HEAD)
printf 'newer worker' > "$WORK/source/deploy/workers/worker.js"
printf 'newer headers' > "$WORK/source/deploy/workers/_headers"
git -C "$WORK/source" add .
git -C "$WORK/source" -c user.name=Test -c user.email=test@example.invalid commit -qm newer
# Redirect only the remote URL to the local fixture.
git() {
  local arg args=()
  for arg in "$@"; do
    case $arg in https://github.com/*.git) args+=("$WORK/source") ;; *) args+=("$arg") ;; esac
  done
  command git "${args[@]}"
}
docker() {
  case $1 in
    build)
      tar -tf - >/dev/null
      while [ $# -gt 0 ]; do
        if [ "$1" = --iidfile ]; then printf image > "$2"; fi
        shift
      done ;;
    create) printf container ;;
    cp) mkdir -p "$3"; printf '<html></html>' > "$3/index.html" ;;
    rm) : ;;
    *) return 1 ;;
  esac
}
GITHUB_REPO=test/source
API_ORIGIN=https://api.example.invalid
WEB_ORIGIN=https://example.invalid
workers_build_export "$WORK/out" "$WORK/runtime"
[ "$(cat "$WORK/runtime/worker.js")" = 'selected worker' ]
[ "$(cat "$WORK/runtime/_headers")" = 'selected headers' ]
echo 'ok    Worker runtime files come from the selected commit, not a newer snapshot'

# Inspect the files actually passed to the publisher.
cat > "$WORK/tools/workers_deploy.py" <<'PY'
import argparse
from pathlib import Path
parser = argparse.ArgumentParser()
parser.add_argument('--worker')
parser.add_argument('--headers')
args, _ = parser.parse_known_args()
assert Path(args.worker).read_text() == 'selected worker'
assert Path(args.headers).read_text() == 'selected headers'
PY
DEPLOY_DIR=$WORK/tools
CLOUDFLARE_API_TOKEN=test
CLOUDFLARE_API_URL=https://example.invalid
WORKERS_SCRIPT=test
WEB_DOMAIN=example.invalid
cf_zone_account_id() { printf account; }
cf_ensure_worker_route() { :; }
workers_publish zone "$WORK/out" "$WORK/runtime"
echo 'ok    publication uses the pinned Worker files'
