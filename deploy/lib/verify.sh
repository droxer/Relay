# Post-deploy checks from deployment-cloudflare.md § 9, run against the live
# hostnames. Hard failures fail the run; cache warm-up only warns.

VERIFY_PASSED=0
VERIFY_FAILURES=0
VERIFY_SKIPPED=0
VERIFY_WARNINGS=0

# One line per check: a colored mark, the check's name, then its detail.
check_line() {
  local mark=$1 label=$2 detail=$3
  printf '    %s %s%s\n' "$mark" "$label" "${detail:+  $detail}" >&2
}

check_pass() {
  check_line "${C_GREEN}✓${C_RESET}" "$1" "${2:+${C_DIM}$2${C_RESET}}"
  VERIFY_PASSED=$((VERIFY_PASSED + 1))
}

check_fail() {
  check_line "${C_RED}✗${C_RESET}" "${C_BOLD}${C_RED}$1${C_RESET}" "$2"
  VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
}

check_skip() {
  check_line "${C_DIM}–${C_RESET}" "${C_DIM}$1${C_RESET}" "${C_DIM}skipped: $2${C_RESET}"
  VERIFY_SKIPPED=$((VERIFY_SKIPPED + 1))
}

check_warn() {
  check_line "${C_YELLOW}!${C_RESET}" "$1" "${C_YELLOW}$2${C_RESET}"
  VERIFY_WARNINGS=$((VERIFY_WARNINGS + 1))
}

# curl already writes 000 when it gets no response, so a failed run must not
# append another. Retries absorb a connection blip during a Railway rollover;
# without --fail an HTTP status is never an error, so 4xx/5xx are not retried.
http_code() {
  local code
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 30 \
    --retry 2 --retry-delay 2 --retry-all-errors "$@" 2>/dev/null) || true
  printf '%s\n' "${code:-000}"
}

expect_code() {
  local label=$1 want=$2 got=$3
  if [ "$got" = "$want" ]; then
    check_pass "$label" "$got"
  else
    check_fail "$label" "expected $want, got $got"
  fi
}

verify_cors() {
  local headers
  headers=$(curl -sS -D - -o /dev/null --max-time 30 -H "Origin: $WEB_ORIGIN" "$API_ORIGIN/api/v1/auth/status" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')
  if grep -qx "access-control-allow-origin: $(printf '%s' "$WEB_ORIGIN" | tr 'A-Z' 'a-z')" <<<"$headers" \
    && grep -qx 'access-control-allow-credentials: true' <<<"$headers"; then
    check_pass "API allows $WEB_ORIGIN with credentials"
  else
    check_fail "API allows $WEB_ORIGIN with credentials" "not allowed (check RELAY_CORS_ALLOW_ORIGINS)"
  fi
}

# Requests that skip Cloudflare must be refused by the origin lock.
verify_origin_lock() {
  local domain
  domain=$(railway_custom_domains "$1" | jq -r '.serviceDomains[0].domain // empty')
  if [ -z "$domain" ]; then
    check_skip "origin lock" "the backend has no *.up.railway.app domain to probe"
    return
  fi
  expect_code "direct origin request is refused" 403 "$(http_code "https://$domain/api/v1/auth/status")"
}

verify_edge_cache() {
  local asset status
  asset=$(curl -sS --max-time 30 "$WEB_ORIGIN/" 2>/dev/null | grep -oE '/_next/static/[^"]+\.js' | head -n 1 || true)
  if [ -z "$asset" ]; then
    check_warn "static asset caching" "no /_next/static asset on $WEB_ORIGIN/ to check"
    return
  fi
  if workers_enabled; then
    verify_worker_assets "$asset"
    return
  fi
  curl -sS -o /dev/null --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null || true
  status=$(curl -sS -I --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "cf-cache-status" {print $2}')
  case $status in
    HIT) check_pass "static assets are served from the edge cache" "HIT" ;;
    *) check_warn "static assets are served from the edge cache" "cf-cache-status is '${status:-missing}', expected HIT once the edge is warm" ;;
  esac
}

# Worker assets come from Cloudflare's asset store, not the zone cache, so
# there is no cf-cache-status to read; check what the Worker promises instead.
verify_worker_assets() {
  local cache_control
  cache_control=$(curl -sS -I --max-time 30 "$WEB_ORIGIN$1" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "cache-control" {print $2}')
  case $cache_control in
    *immutable*) check_pass "static assets are served immutable from the Worker" ;;
    *) check_fail "static assets are served immutable from the Worker" "Cache-Control is '${cache_control:-missing}' (check deploy/workers/_headers)" ;;
  esac
  expect_code "a missing asset is a 404, not the app shell" 404 "$(http_code "$WEB_ORIGIN/_next/static/relay-verify-missing.js")"
}

# The tally after the headline count, e.g. " (1 warned, 1 skipped)".
verify_tally() {
  local parts=""
  [ "$VERIFY_WARNINGS" -eq 0 ] || parts="$VERIFY_WARNINGS warned"
  [ "$VERIFY_SKIPPED" -eq 0 ] || parts="${parts:+$parts, }$VERIFY_SKIPPED skipped"
  printf '%s' "${parts:+ ($parts)}"
}

# verify_deployment <backend-service-id>
verify_deployment() {
  local total
  log "Verifying $WEB_ORIGIN and $API_ORIGIN"
  expect_code "API health through the edge" 200 "$(http_code "$API_ORIGIN/healthz")"
  expect_code "API through the edge" 200 "$(http_code "$API_ORIGIN/api/v1/auth/status")"
  expect_code "web app shell on a client route" 200 "$(http_code "$WEB_ORIGIN/threads")"
  verify_cors
  verify_origin_lock "$1"
  verify_edge_cache
  total=$((VERIFY_PASSED + VERIFY_FAILURES))
  [ "$VERIFY_FAILURES" -eq 0 ] \
    || die "$VERIFY_FAILURES of $total verification checks failed$(verify_tally)"
  printf '%s==> All %s checks passed%s%s\n' "${C_BOLD}${C_GREEN}" "$total" "$(verify_tally)" "$C_RESET" >&2
}
