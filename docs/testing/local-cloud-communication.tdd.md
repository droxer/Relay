# Local/cloud daemon communication fixes

## Source and guarantees

The seven journeys come from the communication review in the user request.
The backend continues to dispatch through daemons, and session/task event logs
remain authoritative. This change adds no backend agent execution.

| Finding | Guarantee | Regression evidence |
| --- | --- | --- |
| Plaintext local launch tokens | Both stores retain hashes only; database migration and local startup erase legacy secrets; reveal requires reissue | `test_daemon_transport_security.py`, `test_daemon_launch_secret_migration.py`, registry/API token tests, `computerToken.test.tsx` |
| Event errors mistaken for invalid payloads | Payload errors return 400; unexpected storage failures return 503; unknown nodes remain 404 | `test_daemon_transport_security.py` |
| Expired managed grant after restart | Saved enrolled identity is reused without redeeming the expired grant; files are mode 0600 | daemon restart test and `managed-enrollment.test.ts` |
| Revoked token restart loop | Registration/poll 401 causes clean shutdown without another registration; heartbeat rejection also initiates shutdown | revoked-token daemon tests |
| Heartbeat lease truncation | Heartbeats send configured lease length; backend validates and forwards 1–3600 seconds | idle-heartbeat daemon test and heartbeat API tests |
| Anonymous node creation | Anonymous registration fails before creating a computer; authenticated admin registration still works | transport security and agent/daemon API tests |
| Permanent outbox rejection | Live/replayed 4xx rejects release queue storage; 408/429/503 remain retryable | status/delivery matrix in `terminal-outbox.test.ts` |

Browser device setup was additionally verified across a backend restart with
both the local and database daemon stores. Single-use redemption issues a token
that authenticates registration without persisting its plaintext.

## RED/GREEN checkpoints

- API transport reproducers failed before implementation. Credential reproducers
  independently failed against both stores before the hash-only fix.
- The compiled daemon/outbox targets produced **18 failures / 6 passes** before
  implementation and **24 passes** afterwards with the same selection:
  `node --test --test-name-pattern='outbox handles HTTP|revoked token|durable enrollment|daemon renews liveness while' dist/packages/relay-daemon/tests/daemon.test.js dist/packages/relay-daemon/tests/terminal-outbox.test.js`.
- Legacy local-secret cleanup and the reissue-only drawer had failing tests
  before their implementation; the drawer's 3 interaction tests passed afterwards.
- The unknown-node event test failed with 503 before adding its typed permanent
  rejection and passed with 404 afterwards; generic `KeyError` failures remain 503.
- Test/fix commits preserve the checkpoints on this branch. This document
  preserves their evidence if the PR is squash merged.

## Final validation

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_daemon_transport_security.py backend/tests/unit/test_daemon_launch_secret_migration.py backend/tests/api/test_daemon_api.py -q -k 'transport_security or launch_secret or device_authorization'`: **21 passed**.
- Focused daemon registry/API/managed-node suites: **392 passed** before integrating
  current main; all those areas also passed in the final full backend run.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-xdist pytest -n 4`: **2269 passed, 1 failed**. The failure is
  `test_schema_review_backfills_derived_columns_and_projections`, whose unscoped
  `pg_constraint` query returns multiple rows in this PostgreSQL environment.
  It also fails serially and on an untouched temporary checkout of `origin/main`.
- Full compiled core/chat/daemon/supervisor/web Node suites: **1985 passed, 2 failed**.
  Both failures reproduce using untouched `origin/main` source: `designGrid`
  rejects an existing `max-width: 720px`, and `projectPage` expects a different
  existing navigation order. All daemon-related suites pass.
- `npm run test:react -w web -- --maxWorkers=2 --testTimeout=120000`:
  **67 files / 430 tests passed**. The default run timed out in a slow roster
  interaction test; its base-branch run passes and the final complete run passes.
- `npm run build:computer`, chat/supervisor builds, and
  `npx tsc -p packages/tsconfig.json`: passed.
- `npm run build -w web -- --webpack`: passed after integrating main.
  `npm test` was attempted, but its default Turbopack build cannot bind a worker
  port in this environment. Suites and the Webpack production build were run
  separately instead.
- Installer integration against the rebuilt real computer bundle: **4 passed**.
- Node coverage for `managed-enrollment.js` and `terminal-outbox.js`:
  **95.65% lines, 90.36% branches, 94.74% functions**. The enrollment helper has
  100% coverage for all three measures. Coverage was measured with
  `node --test --experimental-test-coverage` and those two include filters.
- `npm audit --registry=https://registry.npmjs.org --cache /tmp/relay-npm-cache`:
  **26 existing vulnerabilities** (6 low, 4 moderate, 15 high, 1 critical).
  This PR changes no dependencies.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pip-audit pip-audit`:
  **10 existing advisories in 2 packages** (`anyio`, `virtualenv`); the local
  `relay` package is skipped because it is not published on PyPI.
- `git diff --check`: passed.

## Deployment and limits

Stop old backend processes, apply Alembic **20261010_0089**, and start updated
backend processes. Authentication hashes remain valid; erased secrets cannot be
restored by downgrade. Existing backups are not rewritten. The legacy nullable
column is retained, always written as NULL and ignored by the new code.

Managed daemon host state must persist across process restarts and stay outside
agent workspaces. A host whose state is removed needs a new provisioning grant.
The credential drawer now requires explicit reissue, and revoked daemons stop
successfully until setup reconnects them.
