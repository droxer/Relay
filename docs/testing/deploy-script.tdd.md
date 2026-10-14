# Deployment script regression evidence

Journeys were derived from the deployment review: provision new services without
Config as Code, release the intended commit, preserve unrelated DNS targets,
and ship a usable installer bundle.

| Guarantee | Validation | Result |
| --- | --- | --- |
| Deprecated Config as Code is rejected by the mock | `deploy/tests/run.sh` before the fix | RED: Config as Code is deprecated |
| Explicit backend/web settings preserve migrations, health checks and replica count | `deploy/tests/run.sh` after the fix | GREEN |
| Both release requests pin one commit; invalid SHA and mismatched repo stop the run | `deploy/tests/run.sh` | GREEN |
| Branch-head resolution uses the configured repository and branch | Offline Git stub in `deploy/tests/run.sh` | GREEN |
| Unrelated CNAME targets remain unchanged | `deploy/tests/run.sh` | GREEN |
| Repeated provisioning preserves secrets and avoids duplicate resources | `deploy/tests/run.sh` | GREEN |
| Backend image ships the computer bundle and PostgreSQL client 18 | Docker build and container inspection | PASS |
| Web image serves health, client routes and 404 for missing assets | Docker build and container smoke test | PASS |

The final deployment suite has 51 passing checks. Shell syntax and
`git diff --check` pass. Both Docker images build; the backend reports
`pg_dump (PostgreSQL) 18.6`. The host web build passes with webpack.

The default `npm test` stops at a Turbopack worker port-binding restriction.
Separate TypeScript tests report 2111 passes, 5 failures and 1 skip: two
agent-model assertions and three process/listener restrictions. React tests
report 463 passes and one roster interaction timeout; rerunning that file alone
passes all four tests. Focused Python installer,
backup and deployment tests report 62 passes, two restricted `/dev/tty`
failures and one skip. The broad Python run was interrupted after those same
TTY failures appeared. These failures are outside the changed deployment files.

No real Railway or Cloudflare account mutations were performed. The mock
validates requests and outcomes, not provider-side deployments or certificate
issuance. Shell coverage instrumentation is not configured, so no percentage
coverage is claimed. Changes remain uncommitted for review.

## GraphQL builder enum regression

The real API rejected the first explicit-settings payload with `Problem
processing request`. Public schema introspection shows the `Builder` enum has
`HEROKU`, `NIXPACKS`, `PAKETO`, and `RAILPACK`, but no `DOCKERFILE`.
The config-file value was incorrectly carried into the API payload.

The mock now validates that enum. `deploy/tests/run.sh` reproduced the failure
before the fix (`invalid GraphQL Builder enum`). Both service profiles use
`RAILPACK` with their explicit `dockerfilePath`; Railway selects Dockerfile
builds when that file exists. No account mutation is required for this schema
check. The original real-account request has not been rerun by the agent.

## Interrupted Railway TLS connection

`bash deploy/tests/transport.sh` initially reproduced curl exit 35 and the
`Railway API unreachable` failure on a read. The transport now retries reads
up to three times with backoff, reconstructing stdin on each attempt. Tests
verify recovery, bounded exhaustion, and no automatic mutation replay.

## Railway Dockerfile cache-mount rejection

Read-only build logs for failed deployment `57383e9b-3f9d-490e-80bc-a7cb01bf4b20`
reported two uv cache mounts missing an ID. Railway requires literal
service-scoped cache IDs, which cannot use environment-variable substitution.
`python3 deploy/tests/dockerfile.py` reproduced the violation before the fix.
The backend now uses dependency-layer caching without cache mounts, keeping
one image usable for different projects and backup services. The regression
check runs as part of `deploy/tests/run.sh`.

## Release-source and failure-reporting regression

`deploy/tests/source.py` creates good and bad Git snapshots and repairs the
working tree after committing the bad one. Source validation accepts the good
commit and rejects the bad one, including both the missing web Dockerfile and
invalid cache mount. The same validation is used after fetching the selected
GitHub SHA in the release phase, before starting any service deployment.

`deploy/tests/release.sh` first failed because failure output lacked the
requested deployment ID and build details. It now verifies pinned-ID failures,
unavailable-log handling and timeout reporting. Mock integration tests verify
that invalid source starts zero deployments and a failed backend plus crashed
web both produce diagnostic output and a final two-service failure summary.

These checks run from `deploy/tests/run.sh`. No production push, deployment or
other account mutation is part of this test suite.
