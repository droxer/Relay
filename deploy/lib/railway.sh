# Railway public GraphQL API (https://docs.railway.com/reference/public-api).
# Every ensure_* function looks the resource up first, so a re-run converges
# instead of duplicating. Functions that return a value print it on stdout.

# gql <query> [variables-json] — prints the response's `data` object.
gql() {
  local query=$1 vars=${2:-'{}'} body resp
  body=$(jq -nc --arg q "$query" --argjson v "$vars" '{query: $q, variables: $v}')
  resp=$(curl -sS --max-time 60 -X POST "$RAILWAY_API_URL" \
    -H @<(bearer_header "$RAILWAY_API_TOKEN") \
    -H 'Content-Type: application/json' \
    --data-binary @- <<<"$body") || die "Railway API unreachable at $RAILWAY_API_URL"
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
    data=$(gql 'mutation ProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { id } }' \
      "$(jq -nc --arg n "$RAILWAY_PROJECT_NAME" --arg w "$workspace" --arg e "$RAILWAY_ENVIRONMENT" \
        '{input: {name: $n, workspaceId: $w, defaultEnvironmentName: $e}}')")
    id=$(jq -r '.projectCreate.id' <<<"$data")
    info "created project $RAILWAY_PROJECT_NAME ($id)"
  fi
  printf '%s' "$id"
}

# Sets PROJECT_ID and ENVIRONMENT_ID for the rest of the run.
railway_resolve_context() {
  PROJECT_ID=$(railway_ensure_project)
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
}

# railway_ensure_service <name> <config-as-code path>. The repo is connected
# later (railway_deploy_service), after the config path and variables are in
# place, so the first build already uses the right Dockerfile.
railway_ensure_service() {
  local name=$1 config_file=$2 id data
  id=$(railway_service_id "$name")
  if [ -n "$id" ]; then
    info "service $name exists ($id)"
  else
    data=$(gql 'mutation ServiceCreate($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }' \
      "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg n "$name" '{input: {projectId: $p, environmentId: $e, name: $n}}')")
    id=$(jq -r '.serviceCreate.id' <<<"$data")
    info "created service $name ($id)"
  fi
  gql 'mutation ServiceConfig($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
         serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input) }' \
    "$(jq -nc --arg s "$id" --arg e "$ENVIRONMENT_ID" --arg c "$config_file" \
      '{serviceId: $s, environmentId: $e, input: {railwayConfigFile: $c}}')" >/dev/null
  info "$name builds from $config_file"
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

# Connects the repo on first release, then deploys the branch head. Prints the
# deployment id when the API returns one.
railway_deploy_service() {
  local service_id=$1 data
  if [ -z "$(railway_service_repo "$service_id")" ]; then
    gql 'mutation Connect($id: String!, $input: ServiceConnectInput!) { serviceConnect(id: $id, input: $input) { id } }' \
      "$(jq -nc --arg id "$service_id" --arg r "$GITHUB_REPO" --arg b "$GITHUB_BRANCH" '{id: $id, input: {repo: $r, branch: $b}}')" >/dev/null
    info "connected $GITHUB_REPO@$GITHUB_BRANCH"
  fi
  data=$(gql 'mutation Deploy($s: String!, $e: String!) { serviceInstanceDeployV2(serviceId: $s, environmentId: $e) }' \
    "$(jq -nc --arg s "$service_id" --arg e "$ENVIRONMENT_ID" '{s: $s, e: $e}')")
  jq -r '.serviceInstanceDeployV2 // empty' <<<"$data"
}

railway_deployments() {
  gql 'query Deployments($input: DeploymentListInput!) { deployments(first: 10, input: $input) { edges { node { id status } } } }' \
    "$(jq -nc --arg p "$PROJECT_ID" --arg e "$ENVIRONMENT_ID" --arg s "$1" '{input: {projectId: $p, environmentId: $e, serviceId: $s}}')" \
    | jq -c '[.deployments.edges[].node]'
}

# railway_wait_deployment <service-name> <service-id> [deployment-id]. Without
# an id it waits on the newest deployment.
railway_wait_deployment() {
  local name=$1 service_id=$2 deployment_id=${3:-} waited=0 status
  while :; do
    status=$(railway_deployments "$service_id" | jq -r --arg id "$deployment_id" \
      'if $id == "" then (.[0].status // "NONE") else ([.[] | select(.id == $id)][0].status // "PENDING") end')
    case $status in
      SUCCESS)
        info "$name deployed"
        return
        ;;
      FAILED | CRASHED | REMOVED | SKIPPED) die "$name deployment ended $status — check its build and deploy logs in Railway" ;;
    esac
    [ "$waited" -lt "$DEPLOY_TIMEOUT_SECONDS" ] || die "$name still $status after ${DEPLOY_TIMEOUT_SECONDS}s"
    sleep "$DEPLOY_POLL_SECONDS"
    waited=$((waited + DEPLOY_POLL_SECONDS))
  done
}
