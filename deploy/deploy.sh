#!/usr/bin/env bash
# Provision and deploy Relay on Railway behind Cloudflare.
#
#   deploy/deploy.sh up          railway → cloudflare → release → verify
#   deploy/deploy.sh railway     project, Postgres, services, variables, domains
#   deploy/deploy.sh cloudflare  DNS, TLS, origin-lock header, cache, speed settings
#   deploy/deploy.sh release     deploy the API, background worker, and web UI, wait
#   deploy/deploy.sh verify      check the live hostnames (and email, as `mail` does)
#   deploy/deploy.sh mail        check the invite email settings against Cloudflare
#   deploy/deploy.sh agent-ids   inspect the backend's startup Computer ID migration status
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
  sed -n '2,/^set -/p' "$0" | sed '$d; s/^# \{0,1\}//'
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

# Settings shared by provisioning and upgrades. Give each process time to
# finish store writes on shutdown; preserve any longer configured grace.
backend_process_variables() {
  jq -c '{
    RELAY_BACKGROUND_MODE: "external",
    RAILWAY_DEPLOYMENT_DRAINING_SECONDS: (
      (.RAILWAY_DEPLOYMENT_DRAINING_SECONDS | tonumber? // 35)
      | if . < 35 then 35 else ceil end | tostring
    )
  }' <<<"$1"
}

configure_web_variables() {
  railway_upsert_variables "$WEB_ID" "$(jq -nc --arg api "$API_ORIGIN" --arg web "$WEB_ORIGIN" \
    '{NEXT_PUBLIC_RELAY_API_ORIGIN: $api, NEXT_PUBLIC_RELAY_SITE_URL: $web}')"
}

# Reference the API's effective variables so custom scheduler settings, mail,
# database credentials and R2 settings stay consistent without copying secrets.
# Platform variables and listener settings belong to each service separately.
worker_variables() {
  local backend=$1 current=$2
  jq -nc --arg service "$BACKEND_SERVICE" --argjson backend "$backend" \
    --argjson processes "$(backend_process_variables "$current")" '
    ($backend | to_entries
      | map(select((.key | startswith("RAILWAY_") | not) and .key != "PORT" and .key != "HOST"))
      | map({key: .key, value: ("${{" + $service + "." + .key + "}}")})
      | from_entries) + $processes'
}

configure_worker_service() {
  local backend current name
  railway_ensure_service "$WORKER_SERVICE" worker
  WORKER_ID=$(railway_service_id "$WORKER_SERVICE")
  backend=$(railway_variables "$BACKEND_ID")
  current=$(railway_variables "$WORKER_ID")
  railway_upsert_variables "$WORKER_ID" "$(worker_variables "$backend" "$current")"
  # A reference to a variable the API no longer has resolves to an empty
  # string; drop it so the worker's settings keep matching the API's.
  for name in $(jq -r --arg service "$BACKEND_SERVICE" --argjson backend "$backend" '
      to_entries[]
      | .key as $key
      | select(.value == ("${{" + $service + "." + $key + "}}") and ($backend | has($key) | not))
      | $key' <<<"$current"); do
    railway_delete_variable "$WORKER_ID" "$name"
    info "removed $name from $WORKER_SERVICE ($BACKEND_SERVICE no longer sets it)"
  done
  info "worker variables reference $BACKEND_SERVICE; shared storage is R2"
}

# Mail keys left in Railway after the config turned email off. An empty key
# set (RELAY_MAIL_FROM= …) is the explicit off; keys merely missing from the
# config are left alone, since they may have been set in Railway by hand.
reconcile_mail_variables() {
  local current name
  current=$(railway_variables "$BACKEND_ID")
  if mail_disabled_explicitly; then
    for name in $MAIL_KEYS; do
      jq -e --arg n "$name" 'has($n)' >/dev/null <<<"$current" || continue
      railway_delete_variable "$BACKEND_ID" "$name"
      info "removed $name from $BACKEND_SERVICE (the config turns email off)"
    done
  elif ! mail_enabled && jq -e 'has("RELAY_MAIL_FROM")' >/dev/null <<<"$current"; then
    info "$BACKEND_SERVICE keeps RELAY_MAIL_* set outside the config; set them empty here to remove them"
  fi
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
      RELAY_WAITLIST_ENABLED: $waitlist,
      # A hosted deploy has no host that can boot BoxLite; its cloud computers
      # are Fly Machines. BoxLite stays the local-development stand-in.
      RELAY_MANAGED_NODE_PROVIDER: "fly-machines"
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
  require_r2_storage
  log "Railway: project $RAILWAY_PROJECT_NAME / $RAILWAY_ENVIRONMENT"
  railway_resolve_context
  railway_ensure_postgres
  railway_ensure_service "$BACKEND_SERVICE" backend
  BACKEND_ID=$(railway_service_id "$BACKEND_SERVICE")
  railway_upsert_variables "$BACKEND_ID" "$(backend_variables "$(railway_variables "$BACKEND_ID")")"
  reconcile_mail_variables
  info "backend variables set"
  configure_worker_service
  if workers_enabled; then
    info "the web UI is a Cloudflare Worker (WEB_HOSTING=workers); no Railway web service"
    if [ -n "$(railway_service_id "$WEB_SERVICE")" ]; then
      info "$WEB_SERVICE is unused now; delete it in Railway once 'deploy.sh verify' passes"
    fi
  else
    railway_ensure_service "$WEB_SERVICE" web
    WEB_ID=$(railway_service_id "$WEB_SERVICE")
    configure_web_variables
    info "web variables set"
  fi
  info "R2 holds skill bundles and artifact snapshots; existing volumes are left attached"

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
  require_r2_storage
  log "Release: $GITHUB_REPO@$GITHUB_BRANCH"
  local postgres_id service_id service_repo name
  RELEASE_COMMIT=$(railway_release_commit)
  info "release commit $RELEASE_COMMIT (GitHub source; local edits are not uploaded)"
  railway_validate_release
  resolve_services
  for name in "$BACKEND_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
    service_id=$(railway_service_id "$name")
    [ -n "$service_id" ] || continue
    service_repo=$(railway_service_repo "$service_id")
    [ -z "$service_repo" ] || [ "$service_repo" = "$GITHUB_REPO" ] \
      || die "$name is connected to $service_repo, expected $GITHUB_REPO"
  done
  # Include a retained Railway UI even when Cloudflare hosts the web UI:
  # leaving its branch trigger enabled still creates builds for merged PRs.
  # Disable every target before any build starts.
  for name in "$BACKEND_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
    service_id=$(railway_service_id "$name")
    [ -n "$service_id" ] || continue
    railway_disable_autodeploy "$service_id" || die "could not disable autodeploy for $name"
  done
  postgres_id=$(railway_service_id "$POSTGRES_SERVICE")
  [ -n "$postgres_id" ] || die "service $POSTGRES_SERVICE not found — run 'deploy.sh railway' first"
  railway_wait_deployment "$POSTGRES_SERVICE" "$postgres_id"
  # Upgrade an existing combined deployment, including creating a worker when
  # release is run without a separate provisioning phase.
  railway_ensure_service "$BACKEND_SERVICE" backend
  railway_upsert_variables "$BACKEND_ID" "$(backend_variables "$(railway_variables "$BACKEND_ID")")"
  reconcile_mail_variables
  configure_worker_service
  if workers_enabled; then
    release_backend_and_worker
  else
    release_backend_and_web_service
  fi
}

# Build the UI before deploying the API: a failed local build must not leave
# a newly split API running without its background worker.
release_backend_and_worker() {
  local backend_deployment worker_deployment zone build
  require_cmd docker python3
  zone=$(cf_zone_id)
  build=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "rm -rf '$build'" EXIT
  info "building the web export locally before deploying $BACKEND_SERVICE (this takes a few minutes)"
  workers_build_export "$build/out" "$build/runtime"
  backend_deployment=$(railway_deploy_service "$BACKEND_SERVICE" "$BACKEND_ID")
  railway_wait_deployment "$BACKEND_SERVICE" "$BACKEND_ID" "$backend_deployment" \
    || die "backend deployment failed for commit $RELEASE_COMMIT ($backend_deployment); the web UI was not published"
  # Start the worker only after the API's migrations and queue schema succeed.
  worker_deployment=$(railway_deploy_service "$WORKER_SERVICE" "$WORKER_ID")
  railway_wait_deployment "$WORKER_SERVICE" "$WORKER_ID" "$worker_deployment" \
    || die "worker deployment failed for commit $RELEASE_COMMIT ($worker_deployment); the web UI was not published"
  info "publishing the web UI to Worker $WORKERS_SCRIPT"
  workers_publish "$zone" "$build/out" "$build/runtime"
}

release_backend_and_web_service() {
  local backend_deployment web_deployment worker_deployment=skipped failures=0
  configure_web_variables
  backend_deployment=$(railway_deploy_service "$BACKEND_SERVICE" "$BACKEND_ID")
  web_deployment=$(railway_deploy_service "$WEB_SERVICE" "$WEB_ID")
  info "building $BACKEND_SERVICE and $WEB_SERVICE (this takes a few minutes)"
  if railway_wait_deployment "$BACKEND_SERVICE" "$BACKEND_ID" "$backend_deployment"; then
    worker_deployment=$(railway_deploy_service "$WORKER_SERVICE" "$WORKER_ID")
    if ! railway_wait_deployment "$WORKER_SERVICE" "$WORKER_ID" "$worker_deployment"; then failures=$((failures + 1)); fi
  else
    failures=$((failures + 1))
    warn "$WORKER_SERVICE was not deployed because the API migration/deployment failed"
  fi
  if ! railway_wait_deployment "$WEB_SERVICE" "$WEB_ID" "$web_deployment"; then failures=$((failures + 1)); fi
  [ "$failures" -eq 0 ] || die "$failures service deployment(s) failed for commit $RELEASE_COMMIT (backend: $backend_deployment; worker: $worker_deployment; web: $web_deployment)"
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
  for name in "$POSTGRES_SERVICE" "$BACKEND_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
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

phase_mail() {
  log "Checking invite email settings"
  verify_mail
  [ "$VERIFY_FAILURES" -eq 0 ] || die "$VERIFY_FAILURES email check(s) failed"
  log "Email settings look right; confirm delivery by inviting a verified address"
}

phase_agent_ids() {
  log "Agent Computer IDs: startup migration status"
  railway_resolve_context existing
  local backend_id
  backend_id=$(railway_service_id "$BACKEND_SERVICE")
  [ -n "$backend_id" ] || die "service $BACKEND_SERVICE not found — run 'deploy.sh railway' first"
  railway_agent_computer_id_status "$backend_id"
}

main() {
  local command=${1:-}
  case $command in
    up | railway | cloudflare | release | verify | mail | region | agent-ids) ;;
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
    mail) phase_mail ;;
    region) phase_region ;;
    agent-ids) phase_agent_ids ;;
  esac
}

main "$@"
