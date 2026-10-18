# Post-deploy checks from deployment-cloudflare.md § 9, run against the live
# hostnames. Hard failures fail the run; cache warm-up only warns.

VERIFY_FAILURES=0

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
  if workers_enabled; then
    verify_worker_assets "$asset"
    return
  fi
  curl -sS -o /dev/null --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null || true
  status=$(curl -sS -I --max-time 30 "$WEB_ORIGIN$asset" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "cf-cache-status" {print $2}')
  case $status in
    HIT) info "ok    static assets are served from the edge cache" ;;
    *) warn "static asset cf-cache-status is '${status:-missing}', expected HIT once the edge is warm" ;;
  esac
}

# Worker assets come from Cloudflare's asset store, not the zone cache, so
# there is no cf-cache-status to read; check what the Worker promises instead.
verify_worker_assets() {
  local cache_control
  cache_control=$(curl -sS -I --max-time 30 "$WEB_ORIGIN$1" 2>/dev/null | tr -d '\r' | awk -F': ' 'tolower($1) == "cache-control" {print $2}')
  case $cache_control in
    *immutable*) info "ok    static assets are served immutable from the Worker" ;;
    *)
      info "FAIL  static asset Cache-Control is '${cache_control:-missing}', expected immutable (check deploy/workers/_headers)"
      VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
      ;;
  esac
  expect_code "a missing asset is a 404, not the app shell" 404 "$(http_code "$WEB_ORIGIN/_next/static/relay-verify-missing.js")"
}

# Whether the send token is a live Cloudflare token. An account-owned token
# verifies under its account — which also proves RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID
# is its account; a user-owned one only under /user.
mail_token_active() {
  local path resp
  for path in "/accounts/$RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID/tokens/verify" "/user/tokens/verify"; do
    resp=$(curl -sS --max-time 30 "$CLOUDFLARE_API_URL$path" \
      -H @<(bearer_header "$RELAY_MAIL_CLOUDFLARE_API_TOKEN") 2>/dev/null) || continue
    if jq -e '.success == true and .result.status == "active"' >/dev/null 2>&1 <<<"$resp"; then
      printf '%s\n' "${path%%/tokens/verify}"
      return 0
    fi
  done
  return 1
}

# What can be checked about invite email without sending one. Whether the
# sender domain is onboarded and the token may send only shows on a real send.
verify_mail() {
  local address scope
  if ! mail_enabled; then
    info "skip  email: no RELAY_MAIL_* settings, so admins copy invite links by hand"
    return
  fi
  address=$(mail_sender_address)
  if scope=$(mail_token_active); then
    case $scope in
      /accounts/*) info "ok    email token is active on account $RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID" ;;
      *) info "ok    email token is active (a user token; its account is not checked)" ;;
    esac
  else
    info "FAIL  RELAY_MAIL_CLOUDFLARE_API_TOKEN is not an active Cloudflare token (revoked, expired, or mistyped)"
    VERIFY_FAILURES=$((VERIFY_FAILURES + 1))
  fi
  if in_zone "${address##*@}"; then
    info "ok    sender $address is inside $CLOUDFLARE_ZONE"
  else
    warn "sender $address is outside $CLOUDFLARE_ZONE; its domain must be onboarded in Email Sending on this account"
  fi
  case $RELAY_MAIL_FROM in
    *"<"*) warn "RELAY_MAIL_FROM has a display name; Cloudflare documents only a bare address — if sends fail with a schema error, set RELAY_MAIL_FROM=$address" ;;
  esac
  info "note  onboarding of ${address##*@} and the token's Email Sending permission show only on a send (deployment-cloudflare.md § 10)"
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
  verify_mail
  [ "$VERIFY_FAILURES" -eq 0 ] || die "$VERIFY_FAILURES verification check(s) failed"
  log "All checks passed"
}
