#!/usr/bin/env bash
# Runs deploy.sh against tests/mock_api.py: a full provision, then a second
# run that must change nothing, then the failure modes that must stop a run.
#   deploy/tests/run.sh
set -euo pipefail

TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
bash "$TESTS_DIR/transport.sh"
python3 "$TESTS_DIR/dockerfile.py"
python3 "$TESTS_DIR/source.py"
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

echo "--- first run provisions everything"
start_mock
write_config
run_phases 2>"$WORK/first.log" || { cat "$WORK/first.log"; exit 1; }
FIRST=$(state)
STATE=$FIRST

svc() { printf '(.projects[] | .services[] | select(.name == "%s"))' "$1"; }
BACKEND=$(svc relay-backend)
WEB=$(svc relay-web)

check "one project named relay" '.projects | length == 1 and ([.[] | .name] == ["relay"])'
check "three services" '[.projects[] | .services[] | .name] | sort == ["Postgres", "relay-backend", "relay-web"]'

check "backend Dockerfile, migration, healthcheck and one replica" "$BACKEND | .config | .builder == \"RAILPACK\" and .dockerfilePath == \"backend/Dockerfile\" and .preDeployCommand == [\"alembic -c backend/alembic.ini upgrade head\"] and .healthcheckPath == \"/healthz\" and .numReplicas == 1 and .sleepApplication == false"
check "web Dockerfile and healthcheck" "$WEB | .config | .builder == \"RAILPACK\" and .dockerfilePath == \"web/Dockerfile\" and .healthcheckPath == \"/healthz\" and .preDeployCommand == []"
check "both services track droxer/Relay@main" "[$BACKEND, $WEB] | all(.repo == \"droxer/Relay\" and .branch == \"main\")"
check "both deployments pin the requested commit" "[$BACKEND, $WEB] | all(.deployments[0].commitSha == \"$SOURCE_COMMIT\")"
check "both services deployed once" "[$BACKEND, $WEB] | all(.deployments | length == 1)"
check "backend reaches Postgres by reference" "$BACKEND | .variables.DATABASE_URL == \"\${{Postgres.DATABASE_URL}}\""
check "backend public URLs, CORS, and cookie domain" "$BACKEND | .variables | .RELAY_PUBLIC_BACKEND_URL == \"https://api.get-relay.cc\" and .RELAY_PUBLIC_WEB_URL == \"https://get-relay.cc\" and .RELAY_CORS_ALLOW_ORIGINS == \"https://get-relay.cc\" and .RELAY_SESSION_COOKIE_DOMAIN == \".get-relay.cc\""
check "backend edge lock and client IP header" "$BACKEND | .variables | (.RELAY_EDGE_SECRET | length == 64) and .RELAY_CLIENT_IP_HEADER == \"CF-Connecting-IP\" and .RELAY_FORCE_SECURE_COOKIES == \"1\""
check "backend admin token generated" "$BACKEND | .variables.RELAY_ADMIN_TOKEN | length == 64"
check "no R2 variables without R2 config" "$BACKEND | .variables | has(\"RELAY_BLOB_STORE\") | not"
check "web build points at the API" "$WEB | .variables.NEXT_PUBLIC_RELAY_API_ORIGIN == \"https://api.get-relay.cc\""
check "backend volume at /data" "[.volumes[] | select(.mountPath == \"/data\")] | length == 1"
check "api domain on the backend" "$BACKEND | [.domains[].domain] == [\"api.get-relay.cc\"]"
check "apex domain on the web service" "$WEB | [.domains[].domain] == [\"get-relay.cc\"]"
check "apex CNAME proxied" '[.dns[] | select(.name == "get-relay.cc" and .type == "CNAME" and .proxied)] | length == 1'
check "api CNAME proxied" '[.dns[] | select(.name == "api.get-relay.cc" and .type == "CNAME" and .proxied)] | length == 1'
check "ACME challenges stay DNS-only" '[.dns[] | select(.name | startswith("_acme-challenge.")) | .proxied] == [false, false]'
check "ownership TXT records" '[.dns[] | select(.type == "TXT") | .name] | sort == ["_railway-verify.api.get-relay.cc", "_railway-verify.get-relay.cc"]'
check "TLS Full (strict) and Always Use HTTPS" '.settings.ssl == "strict" and .settings.always_use_https == "on"'
check "edge rule sends the backend's secret to the API host only" "
  ($BACKEND | .variables.RELAY_EDGE_SECRET) as \$secret |
  [.rulesets.http_request_late_transform[] | select(.ref == \"relay_edge_secret\")] |
  length == 1 and .[0].action_parameters.headers[\"X-Relay-Edge\"].value == \$secret
  and .[0].expression == \"(http.host eq \\\"api.get-relay.cc\\\")\""
check "someone else's transform rule is kept" '[.rulesets.http_request_late_transform[] | select(.id == "foreign-1")] | length == 1'
check "five Relay cache rules" '[.rulesets.http_request_cache_settings[] | select(.ref | startswith("relay_cache_"))] | length == 5'

echo "--- second run changes nothing"
run_phases 2>"$WORK/second.log" || { cat "$WORK/second.log"; exit 1; }
STATE=$(jq -n --argjson a "$FIRST" --argjson b "$(state)" '{a: $a, b: $b}')
for op in ProjectCreate ServiceCreate TemplateDeploy VolumeCreate DomainCreate Connect cf.dns.create cf.dns.update \
  cf.settings.ssl cf.settings.always_use_https cf.rules.http_request_late_transform cf.rules.http_request_cache_settings; do
  check "no new $op" ".a.calls[\"$op\"] == .b.calls[\"$op\"]"
done
check "secrets are not rotated" "(.a | $BACKEND | .variables) == (.b | $BACKEND | .variables)"
check "DNS records are not duplicated" '(.a.dns | length) == (.b.dns | length)'
check "each service deployed again" "[.b | $BACKEND, $WEB] | all(.deployments | length == 2)"

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

echo "--- failures stop the run"
write_config 'RELAY_R2_BUCKET=relay-artifacts'
expect_failure "partial R2 config is refused" "RELAY_R2_ACCOUNT_ID is required" deploy railway
write_config 'WEB_DOMAIN=relay.example.com'
expect_failure "domain outside the zone is refused" "is not inside CLOUDFLARE_ZONE" deploy railway
write_config 'RAILWAY_API_TOKEN=wrong'
expect_failure "a rejected Railway token stops the run" "Not Authorized" deploy railway
write_config
deploy railway 2>/dev/null
curl -s -X POST -H 'Authorization: Bearer test-cloudflare-token' -H 'Content-Type: application/json' \
  "http://127.0.0.1:$PORT/client/v4/zones/zone-1/dns_records" \
  -d '{"type": "A", "name": "get-relay.cc", "content": "192.0.2.1"}' >/dev/null
expect_failure "an existing apex A record is never overwritten" "get-relay.cc already has A 192.0.2.1" deploy cloudflare
start_mock
write_config
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
write_config
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
