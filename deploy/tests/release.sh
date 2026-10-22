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

# A refused deploy mutation (e.g. Railway pausing deploys) must fail the call;
# a command substitution does not inherit errexit, so an empty ID used to
# slip through and the release waited on whatever deployment was newest.
GITHUB_REPO=droxer/Relay
railway_service_repo() { printf '%s' "$GITHUB_REPO"; }
gql() { die 'Railway API: Deploys have been paused due to an upstream issue'; }
if id=$(railway_deploy_service backend backend-service 2> "$WORK/error"); then
  echo "FAIL refused deploy returned success with ID '$id'" >&2
  exit 1
fi
grep -q 'Deploys have been paused' "$WORK/error"
gql() { printf '{"serviceInstanceDeployV2":null}'; }
if id=$(railway_deploy_service backend backend-service 2> "$WORK/error"); then
  echo "FAIL deploy without an ID returned success with ID '$id'" >&2
  exit 1
fi
grep -q 'returned no deployment ID' "$WORK/error"
echo 'ok    a refused deploy stops the release instead of waiting on another deployment'
