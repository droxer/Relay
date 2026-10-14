# Post-deploy checks from deployment-cloudflare.md § 9, run against the live
# hostnames. Hard failures fail the run; cache warm-up only warns.

VERIFY_FAILURES=0

http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time 30 "$@" 2>/dev/null || echo 000
}

expect_code() {
  local label=$1 want=$2 got=$3
  if [ "$got" = "$want" ]; then
    info "ok    $label ($got)"
  else
    info "FAIL  $label: expected $want, got $got"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  fi
}

verify_cors() {
  local headers
  headers=$(curl -sS -D - -o /dev/null --max-time 30 -H "Origin: $WEB_ORIGIN" "$API_ORIGIN/api/v1/auth/status" 2>/dev/null | tr -d '\r' | tr 'A-Z' 'a-z')
  if grep -qx "access-control-allow-origin: $(printf '%s' "$WEB_ORIGIN" | tr 'A-Z' 'a-z')" <<<"$headers" \
    && grep -qx 'access-control-allow-credentials: true' <<<"$headers"; then
    info "ok    API allows $WEB_ORIGIN with credentials"
  else
    info "FAIL  API does not allow $WEB_ORIGIN with credentials (check RELAY_CORS_ALLOW_ORIGINS)"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  fi
}

# Requests that skip Cloudflare must be refused by the origin lock.
verify_origin_lock() {
  local domain
  domain=$(railway_custom_domains "$1" | jq -r '.serviceDomains[0].domain // empty')
  if [ -z "$domain" ]; then
    info "skip  origin lock: the backend has no *.up.railway.app domain to probe"
    return
  fi
  expect_code "direct origin request is refused" 403 "$(http_code "https://$domain/api/v1/auth/status")"
}

verify_edge_cache() {
  local asset status
  asset=$(curl -sS --max-time 30 "$WEB_ORIGIN/" 2>/dev/null | grep -oE '/_next/static/[^"]+\.js' | head -n 1 || true)
  if [ -z "$asset" ]; then
    warn "could not find a /_next/static asset on $WEB_ORIGIN/ to check edge caching"
    return
  fi
  curl -sS -o /dev/null --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null || true
  status=$(curl -sS -I --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "cf-cache-status" {print $2}')
  case $status in
    HIT) info "ok    static assets are served from the edge cache" ;;
    *) warn "static asset cf-cache-status is '${status:-missing}', expected HIT once the edge is warm" ;;
  esac
}

# verify_deployment <backend-service-id>
verify_deployment() {
  log "Verifying $WEB_ORIGIN and $API_ORIGIN"
  expect_code "API health through the edge" 200 "$(http_code "$API_ORIGIN/healthz")"
  expect_code "API through the edge" 200 "$(http_code "$API_ORIGIN/api/v1/auth/status")"
  expect_code "web app shell on a client route" 200 "$(http_code "$WEB_ORIGIN/threads")"
  verify_cors
  verify_origin_lock "$1"
  verify_edge_cache
  [ "$VERIFY_FAILURES" -eq 0 ] || die "$VERIFY_FAILURES verification check(s) failed"
  log "All checks passed"
}
