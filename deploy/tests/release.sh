#!/usr/bin/env bash
set -euo pipefail
TESTS_DIR=$(cd "$(dirname "$0")" && pwd)
. "$TESTS_DIR/../lib/common.sh"
. "$TESTS_DIR/../lib/railway.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RAILWAY_PROJECT_NAME=test
RELEASE_COMMIT=0123456789012345678901234567890123456789
PROJECT_ID=project
ENVIRONMENT_ID=environment
DEPLOY_TIMEOUT_SECONDS=0
DEPLOY_POLL_SECONDS=0
# A backend failure must return control to the caller, include logs and retain
# the exact requested ID even when newer deployments exist.
gql() {
  case $1 in
    *'query Deployments'*) printf '{"deployments":{"edges":[{"node":{"id":"newer","status":"SUCCESS"}},{"node":{"id":"backend-dep","status":"FAILED"}}]}}' ;;
    *'query FailureLogs'*) printf '{"buildLogs":[{"message":"cache mount missing id"}],"deploymentLogs":[]}' ;;
    *) return 1 ;;
  esac
}
if (railway_wait_deployment backend backend-service backend-dep) > "$WORK/out" 2> "$WORK/error"; then
  echo 'FAIL backend failure returned success' >&2
  exit 1
fi
grep -q 'backend-dep' "$WORK/error"
grep -q 'cache mount missing id' "$WORK/error"
echo 'ok    failure reports the requested deployment ID and build logs'

# Losing access to logs must preserve the original failure verdict.
gql() {
  case $1 in
    *'query Deployments'*) printf '{"deployments":{"edges":[{"node":{"id":"backend-dep","status":"FAILED"}}]}}' ;;
    *) return 1 ;;
  esac
}
if (railway_wait_deployment backend backend-service backend-dep) > "$WORK/out" 2> "$WORK/error"; then exit 1; fi
grep -q 'could not retrieve logs' "$WORK/error"
grep -q 'ended FAILED' "$WORK/error"
echo 'ok    unavailable logs do not mask the deployment failure'

gql() { printf '{"deployments":{"edges":[{"node":{"id":"backend-dep","status":"BUILDING"}}]}}'; }
if (railway_wait_deployment backend backend-service backend-dep) > "$WORK/out" 2> "$WORK/error"; then exit 1; fi
grep -q 'still BUILDING after 0s' "$WORK/error"
echo 'ok    timeout reports the exact deployment and returns failure'

# A queued deployment has no associated build yet. Its timeout should explain
# that state without issuing a log query that obscures it with an API error.
gql() {
  case $1 in
    *'query Deployments'*) printf '{"deployments":{"edges":[{"node":{"id":"backend-dep","status":"QUEUED"}}]}}' ;;
    *) die 'Deployment does not have an associated build' ;;
  esac
}
if (railway_wait_deployment backend backend-service backend-dep) > "$WORK/out" 2> "$WORK/error"; then exit 1; fi
grep -q 'still QUEUED after 0s' "$WORK/error"
if grep -q 'does not have an associated build' "$WORK/error"; then
  echo 'FAIL queued timeout requested nonexistent build logs' >&2
  exit 1
fi
grep -q 'may still proceed' "$WORK/error"
echo 'ok    queued timeout explains the pending deployment without requesting build logs'

# A refused deploy mutation (e.g. Railway pausing deploys) must fail the call;
# a command substitution does not inherit errexit, so an empty ID used to
# slip through and the release waited on whatever deployment was newest.
GITHUB_REPO=droxer/Relay
railway_service_repo() { printf '%s' "$GITHUB_REPO"; }
gql() {
  case $1 in
    *'query DeploymentTriggers'*) printf '{"deploymentTriggers":{"edges":[],"pageInfo":{"hasNextPage":false}}}' ;;
    *) die 'Railway API: Deploys have been paused due to an upstream issue' ;;
  esac
}
if id=$(railway_deploy_service backend backend-service 2> "$WORK/error"); then
  echo "FAIL refused deploy returned success with ID '$id'" >&2
  exit 1
fi
grep -q 'Deploys have been paused' "$WORK/error"
gql() {
  case $1 in
    *'query DeploymentTriggers'*) printf '{"deploymentTriggers":{"edges":[],"pageInfo":{"hasNextPage":false}}}' ;;
    *) printf '{"serviceInstanceDeployV2":null}' ;;
  esac
}
if id=$(railway_deploy_service backend backend-service 2> "$WORK/error"); then
  echo "FAIL deploy without an ID returned success with ID '$id'" >&2
  exit 1
fi
grep -q 'returned no deployment ID' "$WORK/error"
echo 'ok    a refused deploy stops the release instead of waiting on another deployment'

# Existing automatic triggers are removed before the explicit deploy. Pagination
# must not leave a later trigger enabled; failures must stop the release.
railway_service_repo() { printf '%s' "$GITHUB_REPO"; }
: > "$WORK/disabled"
gql() {
  case $1 in
    *'query DeploymentTriggers'*)
      if jq -e '.after == "next"' >/dev/null <<<"$2"; then
        printf '{"deploymentTriggers":{"edges":[{"node":{"id":"trigger-2"}}],"pageInfo":{"hasNextPage":false,"endCursor":"last"}}}'
      else
        printf '{"deploymentTriggers":{"edges":[{"node":{"id":"trigger-1"}}],"pageInfo":{"hasNextPage":true,"endCursor":"next"}}}'
      fi ;;
    *'mutation DisableAutodeploy'*) jq -r '.id' <<<"$2" >> "$WORK/disabled"; printf '{"deploymentTriggerDelete":true}' ;;
    *'mutation Deploy('*)
      [ "$(wc -l < "$WORK/disabled")" -eq 2 ] || return 1
      printf '{"serviceInstanceDeployV2":"pinned"}' ;;
    *) return 1 ;;
  esac
}
id=$(railway_deploy_service backend backend-service)
[ "$id" = pinned ]
printf 'trigger-1\ntrigger-2\n' > "$WORK/expected"
cmp "$WORK/disabled" "$WORK/expected"
echo 'ok    all autodeploy triggers are removed before a pinned deployment'

gql() {
  case $1 in
    *'query DeploymentTriggers'*) printf '{"deploymentTriggers":{"edges":[{"node":{"id":"trigger"}}],"pageInfo":{"hasNextPage":false}}}' ;;
    *'mutation DisableAutodeploy'*) printf '{"deploymentTriggerDelete":false}' ;;
    *) echo 'unexpected deploy after failed trigger removal' >&2; return 1 ;;
  esac
}
if id=$(railway_deploy_service backend backend-service 2> "$WORK/error"); then
  echo 'FAIL trigger removal failure allowed a deploy' >&2; exit 1
fi
echo 'ok    unsuccessful trigger removal stops the release'

# A new source uses serviceInstanceUpdate, not serviceConnect (which starts a
# branch-head build and creates an automatic trigger).
railway_service_repo() { :; }
gql() {
  case $1 in
    *'query DeploymentTriggers'*) printf '{"deploymentTriggers":{"edges":[],"pageInfo":{"hasNextPage":false}}}' ;;
    *'mutation ReleaseSource'*)
      jq -e --arg r "$GITHUB_REPO" '.input == {source: {repo: $r}}' >/dev/null <<<"$2" || return 1
      printf '{"serviceInstanceUpdate":true}' ;;
    *'mutation Deploy('*) printf '{"serviceInstanceDeployV2":"pinned"}' ;;
    *) echo 'unexpected connection mutation' >&2; return 1 ;;
  esac
}
[ "$(railway_deploy_service backend backend-service)" = pinned ]
echo 'ok    new sources do not create branch-head builds or autodeploy triggers'
