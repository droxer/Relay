# Agent HTTP connection recovery

Journeys were derived from the reported terminal provisioning-attempt conflict
and the local/cloud connection review.

| Guarantee | Regression evidence |
| --- | --- |
| Enrollment may finish before provider allocation returns without losing instance identity or regressing readiness | `test_late_provider_registration_preserves_completed_enrollment` and the managed enrollment HTTP API test |
| Old-generation and stopping daemons cannot mark a managed node ready | `test_old_runtime_cannot_mark_new_generation_ready`, `test_stopping_runtime_cannot_mark_ready` |
| A live provider process cannot remain registering indefinitely; retries respect backoff | `managed reconciler expires a live instance that never registers over HTTP` |
| An online daemon from an old generation is replaced | `healthy HTTP runtime from an old generation is replaced` |
| Offline remote nodes recover through HTTP provisioning without tokens in list responses | `supervisor recovers offline nodes without tokens in HTTP list responses` |
| Remote bootstrap exit is independent of HTTP readiness, and shutdown detaches | `remote bootstrap exit does not replace HTTP registration during its grace period`, `remote recovery follows HTTP liveness after bootstrap and detaches on shutdown` |

RED: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest
backend/tests/unit/test_managed_nodes.py -q` produced 3 failures and 24 passes.
After compiling with `npm run build -w relay-core` and
`npx tsc -p packages/tsconfig.json`,
`node --test dist/packages/relay-supervisor/tests/*.test.js` produced 4 failures
and 35 passes. Checkpoint: `119bf741`.

GREEN: the same backend unit target passed all 27 tests. The focused backend
unit/API run passed 106 tests. The supervisor suite passed all 41 tests.
`npm test` built all packages and the production web application and passed
1,356 TypeScript tests and all 1,106 Python tests (4 dependency deprecation
warnings). After adding the enrolled-timeout follow-up regression, the
TypeScript suite was rerun and passed all 1,357 tests.

A follow-up test, `enrolled runtime readiness timeout can advance to a
replacement attempt`, reproduced a second-pass timeout loop (expected one
replacement, received zero). Restricting the timeout to provisioning phases
allows the next pass to create the replacement without rewriting a succeeded
attempt.

Coverage: `node --experimental-test-coverage --test
 dist/packages/relay-supervisor/tests/*.test.js` reported 96.84% line coverage
for managed reconciliation and 91.67% for legacy/remote reconciliation. The
focused run also imports unrelated core modules; its global coverage is not
whole-repository coverage. No live cloud infrastructure was created or tested.

Dependency audits: the configured npm mirror does not implement the audit
endpoint. Running `npm audit --registry=https://registry.npmjs.org` reported
9 existing advisories (3 moderate, 6 high). `pip-audit` reported no known
vulnerabilities, excluding the local Relay package. Dependencies were not changed.

Remote daemons continue using HTTP(S) registration, heartbeat, command polling,
and run events. A command template is an optional, idempotent bootstrap adapter;
it must not depend on a persistent SSH session to keep the daemon alive.
