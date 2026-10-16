#!/usr/bin/env bash
# Runs deploy.sh against tests/mock_api.py: a full provision, then a second
# run that must change nothing, then the failure modes that must stop a run.
#   deploy/tests/run.sh
set -euo pipefail

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
bash "$TESTS_DIR/transport.sh"
python3 "$TESTS_DIR/dockerfile.py"
python3 "$TESTS_DIR/source.py"
python3 "$TESTS_DIR/workers.py"
node "$TESTS_DIR/worker.mjs"
bash "$TESTS_DIR/release.sh"
DEPLOY=$TESTS_DIR/../deploy.sh
WORK=$(mktemp -d)
REAL_GIT=$(command -v git)
export REAL_GIT
mkdir -p "$WORK/source" "$WORK/bin"
python3 - "$TESTS_DIR/../.." "$WORK/source" <<'PY_SOURCE'
from pathlib import Path
import shutil
import sys
source, target = map(Path, sys.argv[1:])
for name in ["backend/Dockerfile", "web/Dockerfile", "web/Caddyfile", "tools/build-computer.mjs", "package.json", "package-lock.json", "tsconfig.options.json", "backend/pyproject.toml", "backend/uv.lock", "packages/relay-core/package.json", "packages/relay-daemon/package.json", "web/package.json"]:
    (target / name).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source / name, target / name)
PY_SOURCE
git -C "$WORK/source" init -q
git -C "$WORK/source" add .
git -C "$WORK/source" -c user.name=Test -c user.email=test@example.invalid commit -qm 'valid fixture'
SOURCE_COMMIT=$(git -C "$WORK/source" rev-parse HEAD)
rm "$WORK/source/web/Dockerfile"
printf '\nRUN --mount=type=cache,target=/root/.cache/uv true\n' >> "$WORK/source/backend/Dockerfile"
git -C "$WORK/source" add -A
git -C "$WORK/source" -c user.name=Test -c user.email=test@example.invalid commit -qm 'invalid fixture'
BAD_SOURCE_COMMIT=$(git -C "$WORK/source" rev-parse HEAD)
TEST_SOURCE_REPO=$WORK/source
export TEST_SOURCE_REPO
cat > "$WORK/bin/git" <<'GIT_STUB'
#!/usr/bin/env bash
args=()
for arg in "$@"; do
  case $arg in https://github.com/*.git) args+=("$TEST_SOURCE_REPO") ;; *) args+=("$arg") ;; esac
done
exec "$REAL_GIT" "${args[@]}"
GIT_STUB
chmod +x "$WORK/bin/git"
# Stands in for the Docker build of the web export: records the build, and
# `docker cp` yields a small export with a page, a hashed asset and a font.
DOCKER_LOG=$WORK/docker.log
export DOCKER_LOG
cat > "$WORK/bin/docker" <<'DOCKER_STUB'
#!/usr/bin/env bash
set -euo pipefail
case $1 in
  build)
    printf '%s\n' "$*" >> "$DOCKER_LOG"
    tar -tf - | grep -qx 'web/Dockerfile' || { echo 'build context lacks web/Dockerfile' >&2; exit 1; }
    while [ $# -gt 0 ]; do
      [ "$1" = --iidfile ] && printf 'sha256:test-image' > "$2"
      shift
    done
    ;;
  create) echo ctr-test ;;
  cp)
    mkdir -p "$3/_next/static/chunks"
    printf '<html><script src="/_next/static/chunks/app-1.js"></script></html>' > "$3/index.html"
    printf 'console.log(1)' > "$3/_next/static/chunks/app-1.js"
    printf 'wOF2' > "$3/_next/static/chunks/font.woff2"
    ;;
  rm) ;;
  *) echo "unexpected docker $*" >&2; exit 1 ;;
esac
DOCKER_STUB
chmod +x "$WORK/bin/docker"
PORT=$(python3 -c 'import socket; s = socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1])')
MOCK_PID=
FAILURES=0

stop_mock() {
  [ -n "$MOCK_PID" ] || return 0
  kill "$MOCK_PID" 2>/dev/null || true
  wait "$MOCK_PID" 2>/dev/null || true
  MOCK_PID=
}

cleanup() {
  stop_mock
  rm -rf "$WORK"
}
trap cleanup EXIT

start_mock() {
  stop_mock
  python3 "$TESTS_DIR/mock_api.py" "$PORT" &
  MOCK_PID=$!
  local i=0
  until curl -s "http://127.0.0.1:$PORT/__state" >/dev/null; do
    i=$((i + 1))
    [ "$i" -lt 50 ] || { echo "mock API did not start" >&2; exit 1; }
    sleep 0.1
  done
}

write_config() {
  cat >"$WORK/deploy.env" <<EOF
RAILWAY_API_URL=http://127.0.0.1:$PORT/graphql/v2
CLOUDFLARE_API_URL=http://127.0.0.1:$PORT/client/v4
RAILWAY_API_TOKEN=test-railway-token
CLOUDFLARE_API_TOKEN=test-cloudflare-token
RAILWAY_DEPLOY_COMMIT=$SOURCE_COMMIT
DEPLOY_POLL_SECONDS=0
DEPLOY_TIMEOUT_SECONDS=5
$*
EOF
}

state() { curl -s "http://127.0.0.1:$PORT/__state"; }

deploy() { PATH="$WORK/bin:$PATH" DEPLOY_CONFIG=$WORK/deploy.env "$DEPLOY" "$@"; }

check() {
  local label=$1 filter=$2
  if jq -e "$filter" >/dev/null <<<"$STATE"; then
    echo "ok    $label"
  else
    echo "FAIL  $label"
    FAILURES=$((FAILURES + 1))
  fi
}

expect_failure() {
  local label=$1 pattern=$2 output
  shift 2
  if output=$("$@" 2>&1); then
    echo "FAIL  $label: the run succeeded"
    FAILURES=$((FAILURES + 1))
  elif grep -q -- "$pattern" <<<"$output"; then
    echo "ok    $label"
  else
    echo "FAIL  $label: expected '$pattern' in: $output"
    FAILURES=$((FAILURES + 1))
  fi
}

run_phases() {
  deploy railway && deploy cloudflare && deploy release
}

echo "--- first run provisions everything (web UI on Workers)"
start_mock
write_config
run_phases 2>"$WORK/first.log" || { cat "$WORK/first.log"; exit 1; }
FIRST=$(state)
STATE=$FIRST

svc() { printf '(.projects[] | .services[] | select(.name == "%s"))' "$1"; }
BACKEND=$(svc relay-backend)
WEB=$(svc relay-web)

check "one project named relay" '.projects | length == 1 and ([.[] | .name] == ["relay"])'
check "no Railway web service" '[.projects[] | .services[] | .name] | sort == ["Postgres", "relay-backend"]'

check "backend Dockerfile, migration, healthcheck and one replica in the region" "$BACKEND | .config | .builder == \"RAILPACK\" and .dockerfilePath == \"backend/Dockerfile\" and .preDeployCommand == [\"alembic -c backend/alembic.ini upgrade head\"] and .healthcheckPath == \"/healthz\" and .multiRegionConfig == {\"asia-southeast1-eqsg3a\": {\"numReplicas\": 1}} and (has(\"numReplicas\") | not) and .sleepApplication == false"
check "backend tracks droxer/Relay@main" "$BACKEND | .repo == \"droxer/Relay\" and .branch == \"main\""
check "backend deployment pins the requested commit" "$BACKEND | .deployments[0].commitSha == \"$SOURCE_COMMIT\""
check "backend deployed once" "$BACKEND | .deployments | length == 1"
check "a new Postgres is redeployed into the region" "$(svc Postgres) | .deployments | length == 2 and .[0].regions == {\"asia-southeast1-eqsg3a\": {\"numReplicas\": 1}}"
check "backend reaches Postgres by reference" "$BACKEND | .variables.DATABASE_URL == \"\${{Postgres.DATABASE_URL}}\""
check "backend public URLs, CORS, and cookie domain" "$BACKEND | .variables | .RELAY_PUBLIC_BACKEND_URL == \"https://api.get-relay.cc\" and .RELAY_PUBLIC_WEB_URL == \"https://get-relay.cc\" and .RELAY_CORS_ALLOW_ORIGINS == \"https://get-relay.cc\" and .RELAY_SESSION_COOKIE_DOMAIN == \".get-relay.cc\""
check "backend edge lock and client IP header" "$BACKEND | .variables | (.RELAY_EDGE_SECRET | length == 64) and .RELAY_CLIENT_IP_HEADER == \"CF-Connecting-IP\" and .RELAY_FORCE_SECURE_COOKIES == \"1\""
check "backend admin token generated" "$BACKEND | .variables.RELAY_ADMIN_TOKEN | length == 64"
check "waitlist on by default" "$BACKEND | .variables.RELAY_WAITLIST_ENABLED == \"1\""
check "no R2 variables without R2 config" "$BACKEND | .variables | has(\"RELAY_BLOB_STORE\") | not"
check "backend volume at /data" "[.volumes[] | select(.mountPath == \"/data\")] | length == 1"
check "api domain on the backend" "$BACKEND | [.domains[].domain] == [\"api.get-relay.cc\"]"
check "apex is a proxied Worker-only record" '[.dns[] | select(.name == "get-relay.cc")] | length == 1 and .[0].type == "AAAA" and .[0].content == "100::" and .[0].proxied'
check "api CNAME proxied" '[.dns[] | select(.name == "api.get-relay.cc" and .type == "CNAME" and .proxied)] | length == 1'
check "ACME challenge stays DNS-only" '[.dns[] | select(.name | startswith("_acme-challenge.")) | .proxied] == [false]'
check "ownership TXT record for the API" '[.dns[] | select(.type == "TXT") | .name] == ["_railway-verify.api.get-relay.cc"]'
check "TLS Full (strict) and Always Use HTTPS" '.settings.ssl == "strict" and .settings.always_use_https == "on"'
check "HTTP/3, 0-RTT, Early Hints and Smart Tiered Cache" '.settings | .http3 == "on" and .["0rtt"] == "on" and .early_hints == "on" and .tiered_cache_smart_topology_enable == "on"'
check "edge rule sends the backend's secret to the API host only" "
  ($BACKEND | .variables.RELAY_EDGE_SECRET) as \$secret |
  [.rulesets.http_request_late_transform[] | select(.ref == \"relay_edge_secret\")] |
  length == 1 and .[0].action_parameters.headers[\"X-Relay-Edge\"].value == \$secret
  and .[0].expression == \"(http.host eq \\\"api.get-relay.cc\\\")\""
check "someone else's transform rule is kept" '[.rulesets.http_request_late_transform[] | select(.id == "foreign-1")] | length == 1'
check "five Relay cache rules" '[.rulesets.http_request_cache_settings[] | select(.ref | startswith("relay_cache_"))] | length == 5'
check "hashed web assets never keep an error at the edge" '.rulesets.http_request_cache_settings[] | select(.ref == "relay_cache_next_static") | .action_parameters.edge_ttl.status_code_ttl == [{"status_code_range": {"from": 400, "to": 599}, "value": -1}]'
check "Worker relay-web serves the export through the assets binding" '.workers["relay-web"] | .metadata.main_module == "worker.js" and .metadata.bindings == [{"type": "assets", "name": "ASSETS"}] and (.module | contains("env.ASSETS.fetch"))'
check "Worker falls through to worker.js on a miss and carries _headers" '.workers["relay-web"].metadata.assets.config | .not_found_handling == "none" and (._headers | contains("immutable"))'
check "Worker manifest holds the export" '.workers["relay-web"].manifest | keys == ["/_next/static/chunks/app-1.js", "/_next/static/chunks/font.woff2", "/index.html"]'
check "assets upload with their content types" '[.assets[] | .type] | sort == ["font/woff2", "text/html", "text/javascript"]'
check "web host routes to the Worker" '.routes == [.routes[0]] and .routes[0].pattern == "get-relay.cc/*" and .routes[0].script == "relay-web"'
if grep -q -- '--build-arg NEXT_PUBLIC_RELAY_API_ORIGIN=https://api.get-relay.cc' "$DOCKER_LOG" \
  && grep -q -- '--build-arg NEXT_PUBLIC_RELAY_SITE_URL=https://get-relay.cc' "$DOCKER_LOG" \
  && grep -q -- '-f web/Dockerfile --target build' "$DOCKER_LOG"; then
  echo "ok    web export builds in Docker from the release source, pointed at the API"
else
  echo "FAIL  web export build arguments: $(cat "$DOCKER_LOG")"
  FAILURES=$((FAILURES + 1))
fi

echo "--- second run changes nothing"
run_phases 2>"$WORK/second.log" || { cat "$WORK/second.log"; exit 1; }
STATE=$(jq -n --argjson a "$FIRST" --argjson b "$(state)" '{a: $a, b: $b}')
for op in ProjectCreate ServiceCreate TemplateDeploy ServiceRedeploy VolumeCreate DomainCreate Connect cf.dns.create cf.dns.update \
  cf.settings.ssl cf.settings.always_use_https cf.settings.http3 cf.settings.0rtt cf.settings.early_hints \
  cf.settings.tiered_cache_smart_topology_enable cf.rules.http_request_late_transform cf.rules.http_request_cache_settings \
  cf.routes.create cf.routes.update cf.workers.upload; do
  check "no new $op" ".a.calls[\"$op\"] == .b.calls[\"$op\"]"
done
check "secrets are not rotated" "(.a | $BACKEND | .variables) == (.b | $BACKEND | .variables)"
check "DNS records are not duplicated" '(.a.dns | length) == (.b.dns | length)'
check "backend deployed again" ".b | $BACKEND | .deployments | length == 2"
check "Worker republished" '.b.calls["cf.workers.script"] == 2'

echo "--- a failed backend release does not publish the web UI"
curl -fsS -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/__scenario" -d '{"relay-backend":"FAILED"}' >/dev/null
BEFORE=$(state | jq '.calls["cf.workers.script"]')
expect_failure "backend failure stops the release" "the web UI was not published" deploy release
STATE=$(jq -nc --argjson before "$BEFORE" --argjson after "$(state | jq '.calls["cf.workers.script"]')" '{before: $before, after: $after}')
check "no Worker upload after a failed backend" '.before == .after'

echo "--- moving region"
start_mock
write_config 'WEB_HOSTING=railway'
run_phases 2>/dev/null || exit 1
write_config 'WEB_HOSTING=railway
RAILWAY_REGION=europe-west4-drams3a'
deploy railway 2>"$WORK/region-railway.log"
STATE=$(state)
if grep -q "Postgres runs in asia-southeast1-eqsg3a, not europe-west4-drams3a" "$WORK/region-railway.log"; then
  echo "ok    a re-run names the Postgres region it will not move"
else
  echo "FAIL  no warning that Postgres stays in its old region: $(cat "$WORK/region-railway.log")"
  FAILURES=$((FAILURES + 1))
fi
check "a re-run never moves Postgres" "$(svc Postgres) | .regions == {\"asia-southeast1-eqsg3a\": {\"numReplicas\": 1}}"
check "a changed region replaces the old one instead of adding a copy" "$BACKEND | .config.multiRegionConfig == {\"asia-southeast1-eqsg3a\": null, \"europe-west4-drams3a\": {\"numReplicas\": 1}}"
expect_failure "a region move needs confirmation" "CONFIRM_REGION_MOVE=europe-west4-drams3a" deploy region
write_config 'WEB_HOSTING=railway
RAILWAY_REGION=europe-west4-drams3a
CONFIRM_REGION_MOVE=europe-west4-drams3a'
deploy region 2>"$WORK/region.log" || { cat "$WORK/region.log"; exit 1; }
STATE=$(state)
check "every service is redeployed into the new region" "[$(svc Postgres), $BACKEND, $WEB] | all(.deployments[0].regions == {\"europe-west4-drams3a\": {\"numReplicas\": 1}})"
check "a moved service keeps its commit" "$BACKEND | .deployments[0].commitSha == \"$SOURCE_COMMIT\""
BEFORE=$(state | jq '.calls.ServiceRedeploy')
deploy region 2>/dev/null || exit 1
STATE=$(jq -nc --argjson before "$BEFORE" --argjson after "$(state | jq '.calls.ServiceRedeploy')" '{before: $before, after: $after}')
check "a second region run redeploys nothing" '.before == .after'

echo "--- moving an existing Railway-hosted UI to Workers"
start_mock
write_config 'WEB_HOSTING=railway'
deploy railway 2>/dev/null && deploy cloudflare 2>/dev/null
write_config
run_phases 2>"$WORK/move.log" || { cat "$WORK/move.log"; exit 1; }
STATE=$(state)
check "the Railway CNAME stays as the rollback path" '[.dns[] | select(.name == "get-relay.cc") | .type] == ["CNAME"]'
check "the route answers in front of it" '.routes[0].pattern == "get-relay.cc/*" and .routes[0].script == "relay-web"'
if grep -q "relay-web is unused now" "$WORK/move.log"; then
  echo "ok    the old web service is flagged for deletion, not deleted"
else
  echo "FAIL  no note about the unused relay-web service"
  FAILURES=$((FAILURES + 1))
fi
check "the old web service is left in place" "[$WEB] | length == 1"

echo "--- a route held by another Worker is never taken over"
start_mock
write_config
deploy railway 2>/dev/null && deploy cloudflare 2>/dev/null
curl -s -X POST -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/__seed_route" -d '{"pattern": "get-relay.cc/*", "script": "marketing-site"}' >/dev/null
expect_failure "a foreign Worker route is refused" "already serves Worker marketing-site" deploy release

echo "--- web UI on Railway (WEB_HOSTING=railway)"
start_mock
write_config 'WEB_HOSTING=railway'
run_phases 2>"$WORK/railway.log" || { cat "$WORK/railway.log"; exit 1; }
STATE=$(state)
check "three services" '[.projects[] | .services[] | .name] | sort == ["Postgres", "relay-backend", "relay-web"]'
check "web Dockerfile and healthcheck" "$WEB | .config | .builder == \"RAILPACK\" and .dockerfilePath == \"web/Dockerfile\" and .healthcheckPath == \"/healthz\" and .preDeployCommand == []"
check "both services track droxer/Relay@main" "[$BACKEND, $WEB] | all(.repo == \"droxer/Relay\" and .branch == \"main\")"
check "both deployments pin the requested commit" "[$BACKEND, $WEB] | all(.deployments[0].commitSha == \"$SOURCE_COMMIT\")"
check "web build points at the API" "$WEB | .variables.NEXT_PUBLIC_RELAY_API_ORIGIN == \"https://api.get-relay.cc\""
check "web build declares its public address" "$WEB | .variables.NEXT_PUBLIC_RELAY_SITE_URL == \"https://get-relay.cc\""
check "apex domain on the web service" "$WEB | [.domains[].domain] == [\"get-relay.cc\"]"
check "apex CNAME proxied" '[.dns[] | select(.name == "get-relay.cc" and .type == "CNAME" and .proxied)] | length == 1'
check "ACME challenges stay DNS-only" '[.dns[] | select(.name | startswith("_acme-challenge.")) | .proxied] == [false, false]'
check "no Worker or route" '(.workers | length == 0) and (.routes | length == 0)'

echo "--- R2 config replaces the volume"
start_mock
write_config 'RELAY_R2_ACCOUNT_ID=acct
RELAY_R2_ACCESS_KEY_ID=key
RELAY_R2_SECRET_ACCESS_KEY=secret
RELAY_R2_BUCKET=relay-artifacts'
deploy railway 2>/dev/null
STATE=$(state)
check "R2 variables set" "$BACKEND | .variables.RELAY_BLOB_STORE == \"r2\" and .variables.RELAY_R2_BUCKET == \"relay-artifacts\""
check "no volume with R2" '.volumes | length == 0'

echo "--- waitlist and email variables pass through"
start_mock
write_config 'RELAY_WAITLIST_ENABLED=1
RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID=acct
RELAY_MAIL_CLOUDFLARE_API_TOKEN=send-only
RELAY_MAIL_FROM=invites@mail.get-relay.cc'
deploy railway 2>/dev/null
STATE=$(state)
check "waitlist and mail variables set" "$BACKEND | .variables.RELAY_WAITLIST_ENABLED == \"1\" and .variables.RELAY_MAIL_FROM == \"invites@mail.get-relay.cc\" and .variables.RELAY_MAIL_CLOUDFLARE_API_TOKEN == \"send-only\""

echo "--- the waitlist can be turned off"
start_mock
write_config 'RELAY_WAITLIST_ENABLED=0'
deploy railway 2>/dev/null
STATE=$(state)
check "waitlist off when opted out" "$BACKEND | .variables.RELAY_WAITLIST_ENABLED == \"0\""

echo "--- failures stop the run"
write_config 'RELAY_R2_BUCKET=relay-artifacts'
expect_failure "partial R2 config is refused" "RELAY_R2_ACCOUNT_ID is required" deploy railway
write_config 'RELAY_MAIL_FROM=invites@mail.get-relay.cc'
expect_failure "partial mail config is refused" "RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID is required" deploy railway
write_config 'WEB_DOMAIN=relay.example.com'
expect_failure "domain outside the zone is refused" "is not inside CLOUDFLARE_ZONE" deploy railway
write_config 'RAILWAY_API_TOKEN=wrong'
expect_failure "a rejected Railway token stops the run" "Not Authorized" deploy railway
write_config 'WEB_HOSTING=pages'
expect_failure "unknown web hosting is refused" "WEB_HOSTING must be workers or railway" deploy railway
write_config 'WEB_HOSTING=railway'
deploy railway 2>/dev/null
curl -s -X POST -H 'Authorization: Bearer test-cloudflare-token' -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/client/v4/zones/zone-1/dns_records" \
  -d '{"type": "A", "name": "get-relay.cc", "content": "192.0.2.1"}' >/dev/null
expect_failure "an existing apex A record is never overwritten" "get-relay.cc already has A 192.0.2.1" deploy cloudflare
write_config
expect_failure "a DNS-only web record is refused for Workers" "get-relay.cc has DNS-only A 192.0.2.1" deploy cloudflare
start_mock
write_config 'WEB_HOSTING=railway'
deploy railway 2>/dev/null
curl -s -X POST -H 'Authorization: Bearer test-cloudflare-token' -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/client/v4/zones/zone-1/dns_records" \
  -d '{"type": "CNAME", "name": "get-relay.cc", "content": "other.example.com"}' >/dev/null
expect_failure "an existing unrelated CNAME is never overwritten" "already points to" deploy cloudflare
STATE=$(state)
check "foreign CNAME target is preserved" '.dns[0].content == "other.example.com"'
write_config 'RAILWAY_DEPLOY_COMMIT=not-a-sha'
expect_failure "invalid release SHA is refused" "must be a full lowercase commit SHA" deploy release
# Use already-connected services to exercise the repository guard.
write_config
deploy release 2>/dev/null
write_config 'GITHUB_REPO=someone/else'
expect_failure "connected repository mismatch is refused" "expected someone/else" deploy release
expect_failure "unknown command" "unknown command" deploy nonsense

echo "--- release validates source before creating deployments"
write_config "RAILWAY_DEPLOY_COMMIT=$BAD_SOURCE_COMMIT"
BEFORE=$(state | jq '.calls.Deploy')
expect_failure "unfixed selected commit is rejected" "missing required build input: web/Dockerfile" deploy release
STATE=$(jq -nc --argjson before "$BEFORE" --argjson after "$(state | jq '.calls.Deploy')" '{before: $before, after: $after}')
check "invalid source creates no deployments" '.before == .after'
write_config 'WEB_HOSTING=railway'
curl -fsS -X POST -H 'Content-Type: application/json' "http://127.0.0.1:$PORT/__scenario" \
  -d '{"relay-backend":"FAILED","relay-web":"CRASHED"}' >/dev/null
if deploy release > "$WORK/failure.out" 2>&1; then
  echo 'FAIL release succeeded with failed services'
  FAILURES=$((FAILURES + 1))
fi
for expected in 'relay-backend deployment' 'relay-web deployment' 'relay-backend build failure detail' 'relay-web build failure detail' '2 service deployment(s) failed'; do
  if grep -Fq "$expected" "$WORK/failure.out"; then
    echo "ok    failed release reports $expected"
  else
    cat "$WORK/failure.out"
    FAILURES=$((FAILURES + 1))
  fi
done

echo "--- branch resolution without a network connection"
resolved=$(
  . "$TESTS_DIR/../lib/common.sh"
  . "$TESTS_DIR/../lib/railway.sh"
  unset RAILWAY_DEPLOY_COMMIT
  GITHUB_REPO=droxer/Relay
  GITHUB_BRANCH=release
  git() {
    [ "$*" = 'ls-remote --exit-code https://github.com/droxer/Relay.git refs/heads/release' ] || return 1
    printf 'abcdefabcdefabcdefabcdefabcdefabcdefabcd\trefs/heads/release\n'
  }
  railway_release_commit
)
STATE=$(jq -nc --arg sha "$resolved" '{sha: $sha}')
check "release resolves the configured branch head" '.sha == "abcdefabcdefabcdefabcdefabcdefabcdefabcd"'

echo
if [ "$FAILURES" -gt 0 ]; then
  echo "$FAILURES check(s) failed"
  exit 1
fi
echo "all checks passed"
