# Running-service health and restarts: `deploy.sh status` and `deploy.sh restart`.
# Railway reports a hung process as a SUCCESS deployment and its ON_FAILURE
# restart policy never fires for a process that does not exit, so health is
# judged by probing the public hostnames, not by deployment status alone.

HEALTH_FAILURES=0

# The deployment serving traffic: the newest that came up, crashed or not.
# A newer in-progress or failed deployment does not replace it.
railway_serving_deployment() {
  jq -c '[.[] | select(.status == "SUCCESS" or .status == "CRASHED" or .status == "SLEEPING")][0] // empty' <<<"$1"
}

# The app services in restart order: the API first, so the worker and the
# Railway-hosted UI come back against a running API. Prints "name<TAB>id".
health_app_services() {
  local name id
  for name in "$BACKEND_SERVICE" "$WORKER_SERVICE" "$WEB_SERVICE"; do
    id=$(railway_service_id "$name")
    [ -z "$id" ] || printf '%s\t%s\n' "$name" "$id"
  done
}

# How long ago the deployment last printed anything, e.g. "12s"; empty if it
# never did. A hung process stops logging while Railway still says SUCCESS.
railway_last_log_age() {
  gql 'query DeploymentLogs($id: String!) { deploymentLogs(deploymentId: $id, limit: 20) { timestamp } }' \
    "$(jq -nc --arg id "$1" '{id: $id}')" \
    | jq -r '[.deploymentLogs[]?.timestamp // empty | sub("\\.[0-9]+"; "") | fromdateiso8601]
        | max // empty | now - . | floor | if . < 0 then 0 else . end
        | if . >= 3600 then "\(. / 3600 | floor)h" elif . >= 60 then "\(. / 60 | floor)m" else "\(.)s" end'
}

# The public URL that proves a service answers, if it has one.
health_probe_url() {
  case $1 in
    "$BACKEND_SERVICE") printf '%s/api/v1/auth/status' "$API_ORIGIN" ;;
    "$WEB_SERVICE") workers_enabled || printf '%s/' "$WEB_ORIGIN" ;;
  esac
  return 0
}

health_fail() {
  info "FAIL  $*"
  HEALTH_FAILURES=$((HEALTH_FAILURES + 1))
}

health_service_status() {
  local name=$1 id=$2 data serving serving_id newest_id status age line
  data=$(railway_deployments "$id") || { health_fail "$name: deployment lookup failed"; return; }
  serving=$(railway_serving_deployment "$data")
  if [ -z "$serving" ]; then
    health_fail "$name: no running deployment (newest: $(jq -r '.[0].status // "none"' <<<"$data"))"
    return
  fi
  serving_id=$(jq -r .id <<<"$serving")
  status=$(jq -r .status <<<"$serving")
  line="$name $status $serving_id"
  if [ "$status" = SUCCESS ]; then
    age=$(railway_last_log_age "$serving_id" 2>/dev/null) || age=
    line="$line, last log ${age:-never}${age:+ ago}"
  fi
  newest_id=$(jq -r '.[0].id' <<<"$data")
  [ "$newest_id" = "$serving_id" ] || line="$line (newer deployment $newest_id is $(jq -r '.[0].status' <<<"$data"))"
  if [ "$status" = CRASHED ]; then
    health_fail "$line"
  else
    info "ok    $line"
  fi
}

health_probe() {
  local name=$1 url code
  url=$(health_probe_url "$name")
  [ -n "$url" ] || return 0
  code=$(http_code "$url")
  if [ "$code" = 200 ]; then
    info "ok    $name answers $url ($code)"
  else
    health_fail "$name answers $url with $code, expected 200"
  fi
}

phase_status() {
  local name id
  log "Status: $RAILWAY_PROJECT_NAME/$RAILWAY_ENVIRONMENT"
  railway_resolve_context existing
  id=$(railway_service_id "$POSTGRES_SERVICE")
  [ -z "$id" ] || health_service_status "$POSTGRES_SERVICE" "$id"
  while IFS=$'\t' read -r name id; do
    health_service_status "$name" "$id"
    health_probe "$name"
  done < <(health_app_services)
  [ "$HEALTH_FAILURES" -eq 0 ] || die "$HEALTH_FAILURES health check(s) failed; 'deploy.sh restart' restarts the app services"
  log "Every service is running and answering"
}

# health_wait_probe <service-name>: waits up to RESTART_HEALTH_SECONDS for the
# service's public URL to answer 200. Services without one pass at once.
health_wait_probe() {
  local name=$1 url code waited=0 step=$DEPLOY_POLL_SECONDS
  url=$(health_probe_url "$name")
  [ -n "$url" ] || return 0
  [ "$step" -gt 0 ] || step=1
  while :; do
    code=$(http_code "$url")
    [ "$code" != 200 ] || { info "$name answers $url"; return 0; }
    [ "$waited" -lt "$RESTART_HEALTH_SECONDS" ] || { warn "$name still answers $code at $url after ${RESTART_HEALTH_SECONDS}s"; return 1; }
    sleep "$DEPLOY_POLL_SECONDS"
    waited=$((waited + step))
  done
}

# A redeploy replaces the instance, so it recovers a process that is hung or
# whose host is wedged; a restart reuses the instance and can be refused.
railway_redeploy_deployment() {
  local name=$1 service_id=$2 deployment_id=$3 data new_id
  data=$(gql 'mutation DeploymentRedeploy($id: String!) { deploymentRedeploy(id: $id) { id } }' \
    "$(jq -nc --arg id "$deployment_id" '{id: $id}')") || return 1
  new_id=$(jq -r '.deploymentRedeploy.id // empty' <<<"$data")
  [ -n "$new_id" ] || { warn "Railway returned no deployment ID redeploying $name"; return 1; }
  info "redeploying $name as $new_id"
  railway_wait_deployment "$name" "$service_id" "$new_id" && health_wait_probe "$name"
}

# railway_restart_service <service-name> <service-id>: restarts the serving
# deployment in place, falling back to a redeploy of the same build when
# Railway refuses the restart or the service still does not answer.
railway_restart_service() {
  local name=$1 id=$2 data serving deployment_id
  data=$(railway_deployments "$id") || return 1
  serving=$(railway_serving_deployment "$data")
  [ -n "$serving" ] || { warn "$name has no running deployment to restart; run 'deploy.sh release'"; return 1; }
  deployment_id=$(jq -r .id <<<"$serving")
  info "restarting $name ($deployment_id)"
  # gql exits on API errors; capture it in a subshell so a refused restart
  # reaches the redeploy fallback rather than terminating the whole script.
  if ! data=$(gql 'mutation DeploymentRestart($id: String!) { deploymentRestart(id: $id) }' \
    "$(jq -nc --arg id "$deployment_id" '{id: $id}')"); then
    warn "Railway refused to restart $name; redeploying the same build instead"
    railway_redeploy_deployment "$name" "$id" "$deployment_id"
    return
  fi
  railway_wait_deployment "$name" "$id" "$deployment_id" && health_wait_probe "$name" && return 0
  warn "$name did not recover from the restart; redeploying the same build instead"
  railway_redeploy_deployment "$name" "$id" "$deployment_id"
}

# Maps a restart argument to a service name: the configured names, or the
# short aliases backend, worker, web, and postgres.
health_service_name() {
  case $1 in
    backend | api) printf '%s' "$BACKEND_SERVICE" ;;
    worker) printf '%s' "$WORKER_SERVICE" ;;
    web) printf '%s' "$WEB_SERVICE" ;;
    postgres | database | db) printf '%s' "$POSTGRES_SERVICE" ;;
    "$BACKEND_SERVICE" | "$WORKER_SERVICE" | "$WEB_SERVICE" | "$POSTGRES_SERVICE") printf '%s' "$1" ;;
    *) die "unknown service: $1 (expected backend, worker, web, postgres, or a configured service name)" ;;
  esac
}

# Restarts the named services, or every app service. Postgres is restarted
# only when named: the API is offline while it comes back.
phase_restart() {
  local targets= name id failed=
  railway_resolve_context existing
  if [ "$#" -eq 0 ]; then
    targets=$(health_app_services)
  else
    for name in "$@"; do
      name=$(health_service_name "$name") || exit 1
      id=$(railway_service_id "$name")
      [ -n "$id" ] || die "service $name not found in $RAILWAY_PROJECT_NAME/$RAILWAY_ENVIRONMENT"
      targets=$(printf '%s%s\t%s\n' "${targets:+$targets$'\n'}" "$name" "$id")
    done
  fi
  [ -n "$targets" ] || die "no services to restart in $RAILWAY_PROJECT_NAME/$RAILWAY_ENVIRONMENT"
  log "Restart: $(cut -f1 <<<"$targets" | paste -sd ' ' -)"
  while IFS=$'\t' read -r name id; do
    if railway_restart_service "$name" "$id"; then
      info "$name restarted"
    else
      failed="$failed $name"
    fi
  done <<<"$targets"
  [ -z "$failed" ] || die "restart did not recover:$failed; check the deployment logs in Railway"
  log "Restarted; run 'deploy.sh status' to check every service"
}
