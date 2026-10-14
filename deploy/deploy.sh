#!/usr/bin/env bash
# Provision and deploy Relay on Railway behind Cloudflare.
#
#   deploy/deploy.sh up          railway → cloudflare → release → verify
#   deploy/deploy.sh railway     project, Postgres, services, variables, domains
#   deploy/deploy.sh cloudflare  DNS, TLS, origin-lock header, cache rules
#   deploy/deploy.sh release     deploy the backend and web services, wait
#   deploy/deploy.sh verify      check the live hostnames
#
# Every step is idempotent: re-running converges instead of duplicating.
# Configuration comes from deploy/.env or deploy/config.env (or $DEPLOY_CONFIG).
# See deploy/README.md.
set -euo pipefail

DEPLOY_DIR=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib/common.sh
. "$DEPLOY_DIR/lib/common.sh"
# shellcheck source=lib/railway.sh
. "$DEPLOY_DIR/lib/railway.sh"
# shellcheck source=lib/cloudflare.sh
. "$DEPLOY_DIR/lib/cloudflare.sh"
# shellcheck source=lib/verify.sh
. "$DEPLOY_DIR/lib/verify.sh"

usage() {
  sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
}

# $DEPLOY_CONFIG, else deploy/.env, else deploy/config.env (both git-ignored).
config_path() {
  if [ -n "${DEPLOY_CONFIG:-}" ]; then
    printf '%s' "$DEPLOY_CONFIG"
  elif [ -f "$DEPLOY_DIR/.env" ]; then
    printf '%s' "$DEPLOY_DIR/.env"
  else
    printf '%s' "$DEPLOY_DIR/config.env"
  fi
}

# Looks up the context and the two app services; `railway` creates them.
resolve_services() {
  railway_resolve_context
  BACKEND_ID=$(railway_service_id "$BACKEND_SERVICE")
  WEB_ID=$(railway_service_id "$WEB_SERVICE")
  [ -n "$BACKEND_ID" ] && [ -n "$WEB_ID" ] || die "services $BACKEND_SERVICE/$WEB_SERVICE not found — run 'deploy.sh railway' first"
}

# The backend variables from deployment.md § 1 and deployment-cloudflare.md
# § 2, 6 and 8. Secrets are generated once and then left alone, so a re-run
# never rotates them; set them in deploy/.env to rotate deliberately.
backend_variables() {
  local current=$1 edge_secret admin_token
  edge_secret=${RELAY_EDGE_SECRET:-$(jq -r '.RELAY_EDGE_SECRET // empty' <<<"$current")}
  [ -n "$edge_secret" ] || edge_secret=$(random_secret)
  admin_token=${RELAY_ADMIN_TOKEN:-$(jq -r '.RELAY_ADMIN_TOKEN // empty' <<<"$current")}
  if [ -z "$admin_token" ]; then
    admin_token=$(random_secret)
    printf '\n    RELAY_ADMIN_TOKEN (shown once; it seeds the admin token on first boot):\n    %s\n\n' "$admin_token" >&2
  fi
  jq -nc \
    --arg db "\${{${POSTGRES_SERVICE}.DATABASE_URL}}" \
    --arg api "$API_ORIGIN" --arg web "$WEB_ORIGIN" --arg cookie "$COOKIE_DOMAIN" \
    --arg edge "$edge_secret" --arg admin "$admin_token" \
    --arg pg "${PG_CLIENT_MAJOR:-}" \
    --arg r2_account "${RELAY_R2_ACCOUNT_ID:-}" --arg r2_key "${RELAY_R2_ACCESS_KEY_ID:-}" \
    --arg r2_secret "${RELAY_R2_SECRET_ACCESS_KEY:-}" --arg r2_bucket "${RELAY_R2_BUCKET:-}" '
    {
      DATABASE_URL: $db,
      RELAY_PUBLIC_BACKEND_URL: $api,
      RELAY_PUBLIC_WEB_URL: $web,
      RELAY_CORS_ALLOW_ORIGINS: $web,
      RELAY_SESSION_COOKIE_DOMAIN: $cookie,
      RELAY_FORCE_SECURE_COOKIES: "1",
      RELAY_EDGE_SECRET: $edge,
      RELAY_CLIENT_IP_HEADER: "CF-Connecting-IP",
      RELAY_ADMIN_TOKEN: $admin
    }
    + (if $pg != "" then {PG_CLIENT_MAJOR: $pg} else {} end)
    + (if $r2_bucket != "" then {
        RELAY_BLOB_STORE: "r2",
        RELAY_R2_ACCOUNT_ID: $r2_account,
        RELAY_R2_ACCESS_KEY_ID: $r2_key,
        RELAY_R2_SECRET_ACCESS_KEY: $r2_secret,
        RELAY_R2_BUCKET: $r2_bucket
      } else {} end)'
}

phase_railway() {
  log "Railway: project $RAILWAY_PROJECT_NAME / $RAILWAY_ENVIRONMENT"
  railway_resolve_context
  railway_ensure_postgres
  railway_ensure_service "$BACKEND_SERVICE" backend
  railway_ensure_service "$WEB_SERVICE" web
  BACKEND_ID=$(railway_service_id "$BACKEND_SERVICE")
  WEB_ID=$(railway_service_id "$WEB_SERVICE")

  railway_upsert_variables "$BACKEND_ID" "$(backend_variables "$(railway_variables "$BACKEND_ID")")"
  info "backend variables set"
  railway_upsert_variables "$WEB_ID" "$(jq -nc --arg api "$API_ORIGIN" '{NEXT_PUBLIC_RELAY_API_ORIGIN: $api}')"
  info "web variables set"
  if r2_enabled; then
    info "R2 holds skill bundles and artifact snapshots; no volume needed"
  else
    railway_ensure_volume "$BACKEND_ID" /data
  fi

  railway_ensure_custom_domain "$BACKEND_ID" "$API_DOMAIN"
  railway_ensure_custom_domain "$WEB_ID" "$WEB_DOMAIN"
}

# cloudflare_dns <zone-id> <service-id> <domain>
cloudflare_dns() {
  local records count i
  records=$(railway_domain_dns_records "$2" "$3")
  count=$(jq length <<<"$records")
  if [ "$count" -eq 0 ]; then
    warn "Railway has not published DNS records for $3 yet; re-run 'deploy.sh cloudflare' in a minute"
    return
  fi
  i=0
  while [ "$i" -lt "$count" ]; do
    cf_ensure_record "$1" "$(jq -c ".[$i]" <<<"$records")"
    i=$((i + 1))
  done
}

phase_cloudflare() {
  log "Cloudflare: zone $CLOUDFLARE_ZONE"
  resolve_services
  local zone secret
  zone=$(cf_zone_id)
  cloudflare_dns "$zone" "$BACKEND_ID" "$API_DOMAIN"
  cloudflare_dns "$zone" "$WEB_ID" "$WEB_DOMAIN"
  cf_zone_setting "$zone" ssl strict
  cf_zone_setting "$zone" always_use_https on

  # The backend accepts every secret in its comma-separated list; the edge
  # sends the newest (last), which is how a rotation is staged.
  secret=$(railway_variables "$BACKEND_ID" | jq -r '.RELAY_EDGE_SECRET // empty')
  [ -n "$secret" ] || die "the backend has no RELAY_EDGE_SECRET — run 'deploy.sh railway' first"
  secret=$(printf '%s' "${secret##*,}" | tr -d '[:space:]')
  cf_upsert_phase_rules "$zone" http_request_late_transform "$(cf_edge_secret_rule "$secret")"
  cf_upsert_phase_rules "$zone" http_request_cache_settings "$(cf_cache_rules)"
}

phase_release() {
  log "Release: $GITHUB_REPO@$GITHUB_BRANCH"
  local postgres_id backend_deployment web_deployment failures=0
  RELEASE_COMMIT=$(railway_release_commit)
  info "release commit $RELEASE_COMMIT (GitHub source; local edits are not uploaded)"
  railway_validate_release
  resolve_services
  postgres_id=$(railway_service_id "$POSTGRES_SERVICE")
  [ -n "$postgres_id" ] || die "service $POSTGRES_SERVICE not found — run 'deploy.sh railway' first"
  railway_wait_deployment "$POSTGRES_SERVICE" "$postgres_id"
  backend_deployment=$(railway_deploy_service "$BACKEND_SERVICE" "$BACKEND_ID")
  web_deployment=$(railway_deploy_service "$WEB_SERVICE" "$WEB_ID")
  info "building $BACKEND_SERVICE and $WEB_SERVICE (this takes a few minutes)"
  if ! railway_wait_deployment "$BACKEND_SERVICE" "$BACKEND_ID" "$backend_deployment"; then failures=$((failures + 1)); fi
  if ! railway_wait_deployment "$WEB_SERVICE" "$WEB_ID" "$web_deployment"; then failures=$((failures + 1)); fi
  [ "$failures" -eq 0 ] || die "$failures service deployment(s) failed for commit $RELEASE_COMMIT (backend: $backend_deployment; web: $web_deployment)"
}

phase_verify() {
  resolve_services
  verify_deployment "$BACKEND_ID"
}

main() {
  local command=${1:-}
  case $command in
    up | railway | cloudflare | release | verify) ;;
    -h | --help | help | "")
      usage
      [ -n "$command" ] || exit 2
      exit 0
      ;;
    *)
      usage >&2
      die "unknown command: $command"
      ;;
  esac
  require_cmd curl jq openssl
  load_config "$(config_path)"
  validate_config

  case $command in
    up)
      phase_railway
      phase_cloudflare
      phase_release
      phase_verify
      ;;
    railway) phase_railway ;;
    cloudflare) phase_cloudflare ;;
    release) phase_release ;;
    verify) phase_verify ;;
  esac
}

main "$@"
