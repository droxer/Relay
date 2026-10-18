# Railway public GraphQL API (https://docs.railway.com/reference/public-api).
# Every ensure_* function looks the resource up first, so a re-run converges
# instead of duplicating. Functions that return a value print it on stdout.

# gql <query> [variables-json] — prints the response's `data` object.
gql() {
  local query=$1 vars=${2:-'{}'} body resp attempt=1 attempts=1 status
  body=$(jq -nc --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}')
  # Queries are safe to replay after an interrupted connection. A mutation may
  # already have taken effect, so leave its recovery to the next ensure_* run.
  case $query in query\ *) attempts=3 ;; esac
  while :; do
    if resp=$(curl -sS --connect-timeout 10 --max-time 60 -X POST "$RAILWAY_API_URL" \
      -H @<(bearer_header "$RAILWAY_API_TOKEN") \
      -H 'Content-Type: application/json' \
      --data-binary @- <<<"$body"); then
      break
    else
      status=$?
    fi
    case $status in
      5 | 6 | 7 | 18 | 28 | 35 | 52 | 55 | 56) ;;
      *) die "Railway API unreachable at $RAILWAY_API_URL (curl $status)" ;;
    esac
    [ "$attempt" -lt "$attempts" ] || die "Railway API unreachable at $RAILWAY_API_URL after $attempt attempt(s) (curl $status); re-run the interrupted phase"
    warn "Railway connection failed (curl $status); retrying read request ($((attempt + 1))/$attempts)"
    sleep "$attempt"
    attempt=$((attempt + 1))
  done
  jq -e . >/dev/null 2>&1 <<<"$resp" || die "Railway API returned non-JSON: $(head -c 300 <<<"$resp")"
  if jq -e '(.errors // []) | length > 0' >/dev/null <<<"$resp"; then
    die "Railway API: $(jq -r '[.errors[].message] | join("; ")' <<<"$resp")"
  fi
  jq -c '.data' <<<"$resp"
}

railway_workspace_id() {
  if [ -n "${RAILWAY_WORKSPACE_ID:-}" ]; then
    printf '%s' "$RAILWAY_WORKSPACE_ID"
    return
  fi
  local data count
  data=$(gql 'query Workspaces { me { workspaces { id name } } }')
  count=$(jq '.me.workspaces | length' <<<"$data")
  [ "$count" = 1 ] || die "token sees $count Railway workspaces; set RAILWAY_WORKSPACE_ID to one of: $(jq -r '[.me.workspaces[] | "\(.id) (\(.name))"] | join(", ")' <<<"$data")"
  jq -r '.me.workspaces[0].id' <<<"$data"
}

railway_ensure_project() {
  if [ -n "${RAILWAY_PROJECT_ID:-}" ]; then
    printf '%s' "$RAILWAY_PROJECT_ID"
    return
  fi
  local workspace data id
  workspace=$(railway_workspace_id)
  data=$(gql 'query Projects($workspaceId: String) { projects(workspaceId: $workspaceId) { edges { node { id name } } } }' \
    "$(jq -nc --arg w "$workspace" '{workspaceId: $w}')")
  id=$(jq -r --arg n "$RAILWAY_PROJECT_NAME" '[.projects.edges[].node | select(.name == $n)][0].id // empty' <<<"$data")
  if [ -n "$id" ]; then
    info "project $RAILWAY_PROJECT_NAME exists ($id)"
  else
    [ "${1:-}" != existing ] || die "project $RAILWAY_PROJECT_NAME not found — run 'deploy.sh railway' first"
    data=$(gql 'mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }' \
      "$(jq -nc --arg n "$RAILWAY_PROJECT_NAME" --arg w "$workspace" --arg e "$RAILWAY_ENVIRONMENT" \
        '{input: {name: $n, workspaceId: $w, defaultEnvironmentName: $e}}')")
    id=$(jq -r '.projectCreate.id' <<<"$data")
    info "created project $RAILWAY_PROJECT_NAME ($id)"
  fi
  printf '%s' "$id"
}

# Sets PROJECT_ID and ENVIRONMENT_ID. Pass `existing` to forbid provisioning.
railway_resolve_context() {
  PROJECT_ID=$(railway_ensure_project "${1:-}") || return 1
  local data
  data=$(gql 'query Environments($id: String!) { project(id: $id) { environments { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$PROJECT_ID" '{id: $id}')")
  ENVIRONMENT_ID=$(jq -r --arg n "$RAILWAY_ENVIRONMENT" '[.project.environments.edges[].node | select(.name == $n)][0].id // empty' <<<"$data")
  [ -n "$ENVIRONMENT_ID" ] || die "Railway environment '$RAILWAY_ENVIRONMENT' not found in project $PROJECT_ID"
}

railway_service_id() {
  local data
  data=$(gql 'query Services($id: String!) { project(id: $id) { services { edges { node { id name } } } } }' \
    "$(jq -nc --arg id "$PROJECT_ID" '{id: $id}')")
  jq -r --arg n "$1" '[.project.services.edges[].node | select(.name == $n)][0].id // empty' <<<"$data"
}

railway_ensure_postgres() {
  local id data waited=0
  id=$(railway_service_id "$POSTGRES_SERVICE")
  if [ -n "$id" ]; then
    info "service $POSTGRES_SERVICE exists ($id)"
    railway_in_region "$id" ||
      warn "$POSTGRES_SERVICE runs in $(railway_service_regions "$id" | jq -r 'keys | join(", ")'), not $RAILWAY_REGION; 'deploy.sh region' moves it (README: Moving region)"
    return
  fi
  data=$(gql 'query PostgresTemplate { template(code: "postgres") { id serializedConfig } }')
  gql 'mutation TemplateDeploy($input: TemplateDeployV2Input!) { templateDeployV2(input: $input) { workflowId } }' \
    "$(jq -c --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" \
      '{input: {projectId: $p, environmentId: $e, templateId: .template.id, serializedConfig: .template.serializedConfig}}' <<<"$data")" >/dev/null
  info "deploying the Railway Postgres template"
  until id=$(railway_service_id "$POSTGRES_SERVICE") && [ -n "$id" ]; do
    [ "$waited" -lt 120 ] || die "Postgres template deployed but no '$POSTGRES_SERVICE' service appeared; set POSTGRES_SERVICE to its name"
    sleep 5
    waited=$((waited + 5))
  done
  info "created service $POSTGRES_SERVICE ($id)"
  # The template deploys to Railway's default region. A new database is empty,
  # so it moves now; an existing one moves only through 'deploy.sh region'.
  railway_move_service "$POSTGRES_SERVICE" "$id" || die "$POSTGRES_SERVICE did not come up in $RAILWAY_REGION"
}

# Regions a service is deployed in, as its multiRegionConfig ({} before the
# first deployment).
railway_service_regions() {
  gql 'query ServiceRegions($s: String!, $e: String!) { serviceInstance(serviceId: $s, environmentId: $e) { latestDeployment { meta } } }' \
    "$(jq -nc --arg s "$1" --arg e "$ENVIRONMENT_ID" '{s: $s, e: $e}')" \
    | jq -c '.serviceInstance.latestDeployment.meta.serviceManifest.deploy.multiRegionConfig // {}'
}

railway_in_region() {
  railway_service_regions "$1" | jq -e --arg r "$RAILWAY_REGION" 'keys == [$r]' >/dev/null
}

# railway_region_config <service-id> <replicas>: every region the service runs
# in now is cleared, so a changed RAILWAY_REGION moves it instead of adding a
# second copy. A bare numReplicas would land in Railway's default region.
railway_region_config() {
  railway_service_regions "$1" | jq -c --arg r "$RAILWAY_REGION" --argjson n "$2" \
    'map_values(null) + {($r): {numReplicas: $n}}'
}

# railway_set_region <service-id> <replicas>. Takes effect on the next deploy.
railway_set_region() {
  gql 'mutation ServiceRegion($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
         serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
    "$(jq -nc --arg s "$1" --arg e "$ENVIRONMENT_ID" --argjson m "$(railway_region_config "$1" "$2")" \
      '{serviceId: $s, environmentId: $e, input: {multiRegionConfig: $m}}')" >/dev/null
}

# railway_move_service <service-name> <service-id>: places the service in
# RAILWAY_REGION and redeploys it there, keeping its replica count. Railway
# migrates an attached volume during that deploy, offline.
railway_move_service() {
  local name=$1 id=$2 current replicas before newest waited=0
  current=$(railway_service_regions "$id")
  if jq -e --arg r "$RAILWAY_REGION" 'keys == [$r]' >/dev/null <<<"$current"; then
    info "$name already runs in $RAILWAY_REGION"
    return
  fi
  replicas=$(jq '[.[] | .numReplicas // 1] | add // 1' <<<"$current")
  before=$(railway_deployments "$id" | jq -r '.[0].id // ""')
  railway_set_region "$id" "$replicas"
  gql 'mutation ServiceRedeploy($s: String!, $e: String!) { serviceInstanceRedeploy(serviceId: $s, environmentId: $e) }' \
    "$(jq -nc --arg s "$id" --arg e "$ENVIRONMENT_ID" '{s: $s, e: $e}')" >/dev/null
  info "moving $name from $(jq -r 'keys | join(", ")' <<<"$current") to $RAILWAY_REGION"
  until newest=$(railway_deployments "$id" | jq -r '.[0].id // ""') && [ -n "$newest" ] && [ "$newest" != "$before" ]; do
    [ "$waited" -lt "$DEPLOY_TIMEOUT_SECONDS" ] || { warn "$name: no new deployment after ${DEPLOY_TIMEOUT_SECONDS}s"; return 1; }
    sleep "$DEPLOY_POLL_SECONDS"
    waited=$((waited + DEPLOY_POLL_SECONDS))
  done
  railway_wait_deployment "$name" "$id" "$newest"
}

# Configure services directly before connecting their repo. New services cannot
# opt into Config as Code. Profiles use ServiceInstanceUpdateInput fields.
railway_ensure_service() {
  local name=$1 profile=$2 id data settings regions
  id=$(railway_service_id "$name")
  if [ -n "$id" ]; then
    info "service $name exists ($id)"
  else
    data=$(gql 'mutation ServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }' \
      "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg n "$name" '{input: {projectId: $p, environmentId: $e, name: $n}}')")
    id=$(jq -r '.serviceCreate.id' <<<"$data")
    info "created service $name ($id)"
  fi
  settings="$DEPLOY_DIR/services/$profile.json"
  regions=$(railway_region_config "$id" "$(jq '.numReplicas' "$settings")")
  settings=$(jq -c --argjson m "$regions" '. + {multiRegionConfig: $m} | del(.numReplicas)' "$settings")
  gql 'mutation ServiceConfig($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
         serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
    "$(jq -nc --arg s "$id" --arg e "$ENVIRONMENT_ID" --argjson settings "$settings" \
      '{serviceId: $s, environmentId: $e, input: $settings}')" >/dev/null
  info "$name settings configured ($profile)"
}

# Raw (unrendered) variables of a service, as a JSON object.
railway_variables() {
  gql 'query Variables($p: String!, $e: String!, $s: String) { variables(projectId: $p, environmentId: $e, serviceId: $s, unrendered: true) }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" '{p: $p, e: $e, s: $s}')" | jq -c '.variables // {}'
}

# railway_upsert_variables <service-id> <json-object>. Merges; never deploys.
railway_upsert_variables() {
  gql 'mutation VariablesUpsert($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" --argjson v "$2" \
      '{input: {projectId: $p, environmentId: $e, serviceId: $s, variables: $v, skipDeploys: true}}')" >/dev/null
}

# railway_delete_variable <service-id> <name>. Unlike an upsert this can start
# a deploy, so callers delete only what they mean to.
railway_delete_variable() {
  gql 'mutation VariableDelete($input: VariableDeleteInput!) { variableDelete(input: $input) }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" --arg n "$2" \
      '{input: {projectId: $p, environmentId: $e, serviceId: $s, name: $n}}')" >/dev/null
}

railway_ensure_volume() {
  local service_id=$1 mount=$2 data
  data=$(gql 'query Volumes($id: String!) { environment(id: $id) { volumeInstances { edges { node { serviceId mountPath } } } } }' \
    "$(jq -nc --arg id "$ENVIRONMENT_ID" '{id: $id}')")
  if jq -e --arg s "$service_id" '[.environment.volumeInstances.edges[].node | select(.serviceId == $s)] | length > 0' >/dev/null <<<"$data"; then
    info "backend volume exists"
    return
  fi
  gql 'mutation VolumeCreate($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$service_id" --arg m "$mount" \
      '{input: {projectId: $p, environmentId: $e, serviceId: $s, mountPath: $m}}')" >/dev/null
  info "created a volume at $mount (skill bundles live there without R2)"
}

# Custom domains of a service, with the DNS records Railway asks for.
railway_custom_domains() {
  gql 'query Domains($p: String!, $e: String!, $s: String!) { domains(projectId: $p, environmentId: $e, serviceId: $s) {
         serviceDomains { domain }
         customDomains { domain status { verificationDnsHost verificationToken
           dnsRecords { fqdn recordType requiredValue purpose } } } } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" '{p: $p, e: $e, s: $s}')" | jq -c '.domains'
}

railway_ensure_custom_domain() {
  local service_id=$1 domain=$2
  if railway_custom_domains "$service_id" | jq -e --arg d "$domain" '[.customDomains[] | select(.domain == $d)] | length > 0' >/dev/null; then
    info "custom domain $domain exists"
    return
  fi
  gql 'mutation DomainCreate($input: CustomDomainCreateInput!) { customDomainCreate(input: $input) { id } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$service_id" --arg d "$domain" \
      '{input: {projectId: $p, environmentId: $e, serviceId: $s, domain: $d}}')" >/dev/null
  info "added custom domain $domain"
}

# The Cloudflare records one custom domain needs, as a JSON array of
# {type, name, content, proxied}. Only the traffic record goes through the
# edge; ACME challenges and ownership TXT records must answer Railway directly.
railway_domain_dns_records() {
  railway_custom_domains "$1" | jq -c --arg d "$2" --arg zone "$CLOUDFLARE_ZONE" '
    def fqdn: if . == $zone or endswith("." + $zone) then . else . + "." + $zone end;
    ([.customDomains[] | select(.domain == $d) | .status] | first // {}) as $s |
    [($s.dnsRecords // [])[] | {
        type: (.recordType | sub("^DNS_RECORD_TYPE_"; "")),
        name: .fqdn,
        content: .requiredValue,
        proxied: (.purpose == "DNS_RECORD_PURPOSE_TRAFFIC_ROUTE")
      } | select(.type == "CNAME" or .type == "A" or .type == "TXT")]
    + (if ($s.verificationDnsHost // "") != "" and ($s.verificationToken // "") != ""
       then [{type: "TXT", name: ($s.verificationDnsHost | fqdn), content: $s.verificationToken, proxied: false}]
       else [] end)'
}

railway_service_repo() {
  gql 'query Instance($e: String!, $s: String!) { serviceInstance(environmentId: $e, serviceId: $s) { source { repo } } }' \
    "$(jq -nc --arg e "$ENVIRONMENT_ID" --arg s "$1" '{e: $e, s: $s}')" | jq -r '.serviceInstance.source.repo // empty'
}

# Resolve once so both services release the same branch head. An explicit SHA
# supports private repos and reproducible releases without a GitHub API token.
railway_release_commit() {
  local commit=${RAILWAY_DEPLOY_COMMIT:-}
  if [ -z "$commit" ]; then
    require_cmd git
    commit=$(GIT_TERMINAL_PROMPT=0 git ls-remote --exit-code "https://github.com/$GITHUB_REPO.git" "refs/heads/$GITHUB_BRANCH" | awk '{print $1}') \
      || die "cannot resolve $GITHUB_REPO@$GITHUB_BRANCH; configure Git credentials or set RAILWAY_DEPLOY_COMMIT"
  fi
  printf '%s' "$commit" | grep -Eq '^[0-9a-f]{40}$' || die "RAILWAY_DEPLOY_COMMIT must be a full lowercase commit SHA"
  printf '%s' "$commit"
}

# Fetch into an isolated object database and inspect the exact release commit.
# Never check out or execute files from the remote source.
railway_validate_release() (
  set -euo pipefail
  require_cmd git python3
  local temporary
  temporary=$(mktemp -d)
  trap 'rm -rf "$temporary"' EXIT
  git init --bare --quiet "$temporary/source.git"
  GIT_TERMINAL_PROMPT=0 git --git-dir="$temporary/source.git" fetch --quiet --depth=1 \
    "https://github.com/$GITHUB_REPO.git" "$RELEASE_COMMIT" \
    || die "cannot fetch release source $RELEASE_COMMIT; check Git credentials and repository access"
  python3 "$DEPLOY_DIR/validate-source.py" --git-dir "$temporary/source.git" --commit "$RELEASE_COMMIT" >&2
)

railway_failure_logs() {
  local deployment_id=$1 data
  [ -n "$deployment_id" ] || return 0
  if data=$(gql 'query FailureLogs($id: String!) {
      buildLogs(deploymentId: $id, limit: 80) { message }
      deploymentLogs(deploymentId: $id, limit: 40) { message }
    }' "$(jq -nc --arg id "$deployment_id" '{id: $id}')"); then
    jq -r '(.buildLogs // []) + (.deploymentLogs // []) | .[] | "    " + .message' <<<"$data" >&2
  else
    warn "could not retrieve logs for deployment $deployment_id"
  fi
}

# Connect on first release, then explicitly deploy RELEASE_COMMIT.
# Return the deployment ID so an implicit connect build cannot satisfy the wait.
railway_deploy_service() {
  local name=$1 service_id=$2 data
  local repo
  repo=$(railway_service_repo "$service_id")
  [ -z "$repo" ] || [ "$repo" = "$GITHUB_REPO" ] || die "$name is connected to $repo, expected $GITHUB_REPO"
  if [ -z "$repo" ]; then
    gql 'mutation Connect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }' \
      "$(jq -nc --arg id "$service_id" --arg r "$GITHUB_REPO" --arg b "$GITHUB_BRANCH" '{id: $id, input: {repo: $r, branch: $b}}')" >/dev/null
    info "connected $name to $GITHUB_REPO@$GITHUB_BRANCH"
  fi
  data=$(gql 'mutation Deploy($s: String!, $e: String!, $commitSha: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e, commitSha: $commitSha) }' \
    "$(jq -nc --arg s "$service_id" --arg e "$ENVIRONMENT_ID" --arg sha "$RELEASE_COMMIT" '{s: $s, e: $e, commitSha: $sha}')")
  jq -r '.serviceInstanceDeployV2 // empty' <<<"$data"
}

railway_deployments() {
  gql 'query Deployments($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status } } } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" '{input: {projectId: $p, environmentId: $e, serviceId: $s}}')" \
    | jq -c '[.deployments.edges[].node]'
}

# Startup migration status from the newest successful backend deployment.
# Filter at the API so normal traffic cannot crowd the startup line out of
# the bounded result; sort by timestamp rather than relying on API ordering.
railway_agent_computer_id_status() {
  local service_id=$1 deployment_id data status
  data=$(railway_deployments "$service_id") || return 1
  deployment_id=$(jq -r '[.[] | select(.status == "SUCCESS")][0].id // empty' <<<"$data")
  [ -n "$deployment_id" ] || die "$BACKEND_SERVICE has no successful deployment in recent history"
  info "$BACKEND_SERVICE deployment $deployment_id (startup snapshot)"
  data=$(gql 'query DeploymentLogs($id: String!, $filter: String!) {
      deploymentLogs(deploymentId: $id, filter: $filter, limit: 100) { timestamp message }
    }' "$(jq -nc --arg id "$deployment_id" '{id: $id, filter: "agent-computer-ids"}')") || return 1
  status=$(jq -r '[.deploymentLogs[]?]
    | sort_by(.timestamp // "")
    | [.[].message | capture("agent-computer-ids (?<status>converged|pending agents=[0-9]+ placements=[0-9]+)") | .status]
    | last // empty' <<<"$data")
  [ -n "$status" ] || die "no agent-computer-ids line in deployment $deployment_id; deploy a backend with startup status logging, check RELAY_LOG_LEVEL and log retention, then retry"
  info "agent-computer-ids $status"
  [ "$status" = converged ]
}

# railway_wait_deployment <service-name> <service-id> [deployment-id]. Without
# an id it waits on the newest deployment.
railway_wait_deployment() {
  local name=$1 service_id=$2 deployment_id=${3:-} waited=0 status data observed_id
  while :; do
    data=$(railway_deployments "$service_id") || { warn "$name status lookup failed"; return 1; }
    observed_id=$(jq -r --arg id "$deployment_id" 'if $id == "" then (.[0].id // "") else $id end' <<<"$data")
    status=$(jq -r --arg id "$observed_id" '[.[] | select(.id == $id)][0].status // "PENDING"' <<<"$data")
    case $status in
      SUCCESS)
        info "$name deployed"
        return
        ;;
      FAILED | CRASHED | REMOVED | SKIPPED)
        warn "$name deployment $observed_id ended $status (commit ${RELEASE_COMMIT:-unknown})"
        railway_failure_logs "$observed_id"
        return 1
        ;;
    esac
    if [ "$waited" -ge "$DEPLOY_TIMEOUT_SECONDS" ]; then
      warn "$name deployment $observed_id still $status after ${DEPLOY_TIMEOUT_SECONDS}s"
      railway_failure_logs "$observed_id"
      return 1
    fi
    sleep "$DEPLOY_POLL_SECONDS"
    waited=$((waited + DEPLOY_POLL_SECONDS))
  done
}
