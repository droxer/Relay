# The API retains both daemon routes so removing the Worker route rolls back
# immediately. The Worker only takes traffic after the ingest origin is ready.

configure_daemon_ingest_service() {
  daemon_ingest_enabled || return 0
  configure_shared_backend_service "$DAEMON_INGEST_SERVICE" daemon-ingest '{
    "RELAY_HTTP_ROLE": "daemon-ingest",
    "RELAY_DAEMON_INGEST_CONCURRENCY": "4",
    "RELAY_DB_POOL_SIZE": "8",
    "RELAY_DB_MAX_OVERFLOW": "0"
  }'
  DAEMON_INGEST_ID=$(railway_service_id "$DAEMON_INGEST_SERVICE")
  railway_ensure_custom_domain "$DAEMON_INGEST_ID" "$DAEMON_INGEST_DOMAIN"
}

daemon_ingest_worker_route() {
  printf '%s/api/v1/daemon-nodes/*' "$API_DOMAIN"
}

remove_daemon_ingest_route() {
  local zone=$1 route
  route=$(cf GET "/zones/$zone/workers/routes" | jq -r \
    --arg pattern "$(daemon_ingest_worker_route)" --arg script "$DAEMON_INGEST_WORKER" \
    '.[] | select(.pattern == $pattern and .script == $script) | .id')
  [ -n "$route" ] || return 0
  cf DELETE "/zones/$zone/workers/routes/$route" >/dev/null
  info "daemon event and report traffic returned to $BACKEND_SERVICE"
}

release_daemon_ingest() {
  daemon_ingest_enabled || return 0
  local zone account deployment secret probe
  zone=$(cf_zone_id)
  account=$(cf_zone_account_id)
  deployment=$(railway_deploy_service "$DAEMON_INGEST_SERVICE" "$DAEMON_INGEST_ID")
  railway_wait_deployment "$DAEMON_INGEST_SERVICE" "$DAEMON_INGEST_ID" "$deployment" \
    || die "daemon ingestion deployment failed; the Worker route was not updated"
  cloudflare_dns "$zone" "$DAEMON_INGEST_ID" "$DAEMON_INGEST_DOMAIN" dns-only
  health_wait_probe "$DAEMON_INGEST_SERVICE" || die "daemon ingestion origin did not become reachable"

  secret=$(railway_variables "$BACKEND_ID" | jq -r '.RELAY_EDGE_SECRET // empty')
  secret=$(printf '%s' "${secret##*,}" | tr -d '[:space:]')
  [ -n "$secret" ] || die "daemon ingestion requires the API origin-lock secret"
  probe="$DAEMON_INGEST_ORIGIN/api/v1/daemon-nodes/release-probe/events"
  [ "$(http_code -H 'Content-Type: application/json' --data '{}' "$probe")" = 403 ] \
    || die "daemon ingestion origin did not refuse a direct request"
  [ "$(http_code -H @<(printf 'X-Relay-Edge: %s\n' "$secret") -H 'Content-Type: application/json' --data '{}' "$probe")" = 400 ] \
    || die "daemon ingestion origin did not accept an edge-authenticated route probe"
  [ "$(http_code -H @<(printf 'X-Relay-Edge: %s\n' "$secret") "$DAEMON_INGEST_ORIGIN/api/v1/auth/me")" = 404 ] \
    || die "daemon ingestion origin exposes the browser API"

  RELAY_INGEST_EDGE_SECRET="$secret" python3 "$DEPLOY_DIR/workers_deploy.py" \
    --api-url "$CLOUDFLARE_API_URL" --account "$account" --script "$DAEMON_INGEST_WORKER" \
    --worker "$INGEST_WORKER_SOURCE" --daemon-ingest-origin "$DAEMON_INGEST_ORIGIN" --api-host "$API_DOMAIN" \
    || die "publishing the daemon ingestion Worker failed"
  cf_ensure_worker_route "$zone" "$(daemon_ingest_worker_route)" "$DAEMON_INGEST_WORKER"
}
