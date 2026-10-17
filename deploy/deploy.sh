#!/usr/bin/env bash
# Provision and deploy Relay on Railway behind Cloudflare.
#
#   deploy/deploy.sh up          railway → cloudflare → release → verify
#   deploy/deploy.sh railway     project, Postgres, services, variables, domains
#   deploy/deploy.sh cloudflare  DNS, TLS, origin-lock header, cache, speed settings
#   deploy/deploy.sh release     deploy the backend and the web UI, wait
#   deploy/deploy.sh verify      check the live hostnames
#   deploy/deploy.sh region      move Postgres and the services to RAILWAY_REGION
#                                (offline for minutes; back up first)
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
# shellcheck source=lib/workers.sh
. "$DEPLOY_DIR/lib/workers.sh"
# shellcheck source=lib/verify.sh
. "$DEPLOY_DIR/lib/verify.sh"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
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

# Looks up the context and the app services; `railway` creates them. The web
# service exists only when Railway hosts the UI (WEB_HOSTING=railway).
resolve_services() {
  railway_resolve_context
  BACKEND_ID=$(railway_service_id "$BACKEND_SERVICE")
  [ -n "$BACKEND_ID" ] || die "service $BACKEND_SERVICE not found — run 'deploy.sh railway' first"
  workers_enabled && return
  WEB_ID=$(railway_service_id "$WEB_SERVICE")
  [ -n "$WEB_ID" ] || die "service $WEB_SERVICE not found — run 'deploy.sh railway' first"
}

# Settings shared by provisioning and upgrades during a release. Railway's
# default drain is zero; allow the supervisor's 30-second shutdown and keep
# any longer period the operator already configured.
backend_process_variables() {
  jq -c '{
    RELAY_STORAGE: "postgres",
    RELAY_BACKGROUND_MODE: "external",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: (
      (.RAILWAY_DEPLOYMENT_DRAINING_SECONDS | tonumber? // 35)
      | if . < 35 then 35 else ceil end | tostring
    )
  }' <<<"$1"
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
    --argjson processes "$(backend_process_variables "$current")" \
    --arg db "\${{${POSTGRES_SERVICE}.DATABASE_URL}}" \
    --arg api "$API_ORIGIN" --arg web "$WEB_ORIGIN" --arg cookie "$COOKIE_DOMAIN" \
    --arg edge "$edge_secret" --arg admin "$admin_token" \
    --arg pg "${PG_CLIENT_MAJOR:-}" \
    --arg r2_account "${RELAY_R2_ACCOUNT_ID:-}" --arg r2_key "${RELAY_R2_ACCESS_KEY_ID:-}" \
    --arg r2_secret "${RELAY_R2_SECRET_ACCESS_KEY:-}" --arg r2_bucket "${RELAY_R2_BUCKET:-}" \
    --arg waitlist "${RELAY_WAITLIST_ENABLED:-1}" \
    --arg mail_account "${RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID:-}" \
    --arg mail_token "${RELAY_MAIL_CLOUDFLARE_API_TOKEN:-}" --arg mail_from "${RELAY_MAIL_FROM:-}" '
    {
      DATABASE_URL: $db,
      RELAY_PUBLIC_BACKEND_URL: $api,
      RELAY_PUBLIC_WEB_URL: $web,
      RELAY_CORS_ALLOW_ORIGINS: $web,
      RELAY_SESSION_COOKIE_DOMAIN: $cookie,
      RELAY_FORCE_SECURE_COOKIES: "1",
      RELAY_EDGE_SECRET: $edge,
      RELAY_CLIENT_IP_HEADER: "CF-Connecting-IP",
      RELAY_ADMIN_TOKEN: $admin,
      RELAY_WAITLIST_ENABLED: $waitlist
    }
    + $processes
    + (if $pg != "" then {PG_CLIENT_MAJOR: $pg} else {} end)
    + (if $r2_bucket != "" then {
        RELAY_BLOB_STORE: "r2",
        RELAY_R2_ACCOUNT_ID: $r2_account,
        RELAY_R2_ACCESS_KEY_ID: $r2_key,
        RELAY_R2_SECRET_ACCESS_KEY: $r2_secret,
        RELAY_R2_BUCKET: $r2_bucket
      } else {} end)
    + (if $mail_from != "" then {
        RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID: $mail_account,
        RELAY_MAIL_CLOUDFLARE_API_TOKEN: $mail_token,
        RELAY_MAIL_FROM: $mail_from
      } else {} end)'
}

phase_railway() {
  log "Railway: project $RAILWAY_PROJECT_NAME / $RAILWAY_ENVIRONMENT"
  railway_resolve_context
  railway_ensure_postgres
  railway_ensure_service "$BACKEND_SERVICE" backend
  BACKEND_ID=$(railway_service_id "$BACKEND_SERVICE")
  railway_upsert_variables "$BACKEND_ID" "$(backend_variables "$(railway_variables "$BACKEND_ID")")"
  info "backend variables set"
  if workers_enabled; then
    info "the web UI is a Cloudflare Worker (WEB_HOSTING=workers); no Railway web service"
    if [ -n "$(railway_service_id "$WEB_SERVICE")" ]; then
      info "$WEB_SERVICE is unused now; delete it in Railway once 'deploy.sh verify' passes"
    fi
  else
    railway_ensure_service "$WEB_SERVICE" web
    WEB_ID=$(railway_service_id "$WEB_SERVICE")
    railway_upsert_variables "$WEB_ID" "$(jq -nc --arg api "$API_ORIGIN" --arg web "$WEB_ORIGIN" \
      '{NEXT_PUBLIC_RELAY_API_ORIGIN: $api, NEXT_PUBLIC_RELAY_SITE_URL: $web}')"
    info "web variables set"
  fi
  if r2_enabled; then
    info "R2 holds skill bundles and artifact snapshots; no volume needed"
  else
    railway_ensure_volume "$BACKEND_ID" /data
  fi

  railway_ensure_custom_domain "$BACKEND_ID" "$API_DOMAIN"
  workers_enabled || railway_ensure_custom_domain "$WEB_ID" "$WEB_DOMAIN"
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
  if workers_enabled; then
    cf_ensure_worker_host "$zone" "$WEB_DOMAIN"
  else
    cloudflare_dns "$zone" "$WEB_ID" "$WEB_DOMAIN"
  fi
  cf_zone_setting "$zone" ssl strict
  cf_zone_setting "$zone" always_use_https on
  cf_performance_settings "$zone"

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
  local postgres_id backend_repo
  RELEASE_COMMIT=$(railway_release_commit)
  info "release commit $RELEASE_COMMIT (GitHub source; local edits are not uploaded)"
  railway_validate_release
  resolve_services
  backend_repo=$(railway_service_repo "$BACKEND_ID")
  [ -z "$backend_repo" ] || [ "$backend_repo" = "$GITHUB_REPO" ] \
    || die "$BACKEND_SERVICE is connected to $backend_repo, expected $GITHUB_REPO"
  postgres_id=$(railway_service_id "$POSTGRES_SERVICE")
  [ -n "$postgres_id" ] || die "service $POSTGRES_SERVICE not found — run 'deploy.sh railway' first"
  railway_wait_deployment "$POSTGRES_SERVICE" "$postgres_id"
  # A release also upgrades existing services to the supervised worker entry
  # point. Do this only after the selected source passed validation, and leave
  # unrelated runtime variables and secrets untouched.
  railway_ensure_service "$BACKEND_SERVICE" backend
  railway_upsert_variables "$BACKEND_ID" "$(backend_process_variables "$(railway_variables "$BACKEND_ID")")"
  if workers_enabled; then
    release_backend_and_worker
  else
    release_backend_and_web_service
  fi
}

# The UI builds locally (in Docker) while Railway builds the backend, and is
# published only once the backend it calls is live.
release_backend_and_worker() {
  local backend_deployment zone build
  require_cmd docker python3
  zone=$(cf_zone_id)
  backend_deployment=$(railway_deploy_service "$BACKEND_SERVICE" "$BACKEND_ID")
  build=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$build'" EXIT
  info "building $BACKEND_SERVICE on Railway and the web export locally (this takes a few minutes)"
  workers_build_export "$build/out"
  railway_wait_deployment "$BACKEND_SERVICE" "$BACKEND_ID" "$backend_deployment" \
    || die "backend deployment failed for commit $RELEASE_COMMIT ($backend_deployment); the web UI was not published"
  info "publishing the web UI to Worker $WORKERS_SCRIPT"
  workers_publish "$zone" "$build/out"
}

release_backend_and_web_service() {
  local backend_deployment web_deployment failures=0
  backend_deployment=$(railway_deploy_service "$BACKEND_SERVICE" "$BACKEND_ID")
  web_deployment=$(railway_deploy_service "$WEB_SERVICE" "$WEB_ID")
  info "building $BACKEND_SERVICE and $WEB_SERVICE (this takes a few minutes)"
  if ! railway_wait_deployment "$BACKEND_SERVICE" "$BACKEND_ID" "$backend_deployment"; then failures=$((failures + 1)); fi
  if ! railway_wait_deployment "$WEB_SERVICE" "$WEB_ID" "$web_deployment"; then failures=$((failures + 1)); fi
  [ "$failures" -eq 0 ] || die "$failures service deployment(s) failed for commit $RELEASE_COMMIT (backend: $backend_deployment; web: $web_deployment)"
}

# Moving Postgres migrates its volume offline, so this is never part of `up`:
# it runs only when asked by name and confirmed with the target region.
phase_region() {
  local name id
  log "Region: moving services to $RAILWAY_REGION"
  [ "${CONFIRM_REGION_MOVE:-}" = "$RAILWAY_REGION" ] ||
    die "moving $POSTGRES_SERVICE takes the API offline while its volume migrates; back it up first (README: Moving region), then re-run with CONFIRM_REGION_MOVE=$RAILWAY_REGION"
  railway_resolve_context
  # The database first: a failed move stops before the backend follows it.
  for name in "$POSTGRES_SERVICE" "$BACKEND_SERVICE" "$WEB_SERVICE"; do
    id=$(railway_service_id "$name")
    if [ -z "$id" ]; then
      info "no $name service; skipped"
      continue
    fi
    railway_move_service "$name" "$id" || die "$name did not come up in $RAILWAY_REGION; later services were not moved"
  done
  info "every service runs in $RAILWAY_REGION; run 'deploy.sh verify'"
}

phase_verify() {
  resolve_services
  verify_deployment "$BACKEND_ID"
}

main() {
  local command=${1:-}
  case $command in
    up | railway | cloudflare | release | verify | region) ;;
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
    region) phase_region ;;
  esac
}

main "$@"
