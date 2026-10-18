# Deployed API and Procrastinate worker

The operator's journey is to deploy Relay with periodic work enabled without
running a separate setup command or attaching another service to local skill
storage. Existing deployments must adopt the new launcher on `release`.

## Scope and ownership

- `backend/relay/processes.py` supervises the two Python processes; the
  `serve-with-worker` CLI command invokes it.
- `backend/Dockerfile` and `deploy/services/backend.json` select the launcher.
  Railway's pre-deploy commands apply Alembic migrations and initialize the
  queue schema before runtime startup.
- `deploy/deploy.sh` upgrades managed startup settings on both provisioning
  and release, sets external background mode, and allows at least 35 seconds
  of Railway draining. Longer configured periods and unrelated variables
  are preserved.
- Release-source validation now requires the worker, supervisor, and CLI
  modules in the selected commit before any service settings are changed.
- `make backend-worker` consolidates queue initialization and worker startup,
  retaining the simplification requested immediately before this task.

The API and worker run in one backend container so both can read `/data`
skill objects when R2 is disabled. All Agent Runtime execution still happens
on Daemon Nodes. No new Railway service, domain, or credentials are required.

## RED evidence

- The initial Python supervisor tests failed with
  `ModuleNotFoundError: No module named 'relay.processes'`.
- `python3 deploy/tests/dockerfile.py` failed because the image did not select
  `relay serve-with-worker`.
- These tests were recorded in checkpoint `7f85a75a` before implementation.
- The new source-validation regression failed because a commit missing
  `backend/relay/processes.py` was accepted even after the local working tree
  was repaired. The validator now rejects that selected commit.
- A release-order regression failed because a repository mismatch was
  rejected after service configuration changed. The backend repository
  check now precedes those writes.

## Passing guarantees

| Guarantee | Evidence |
| --- | --- |
| Either child exiting, even with code zero, fails the container and stops its sibling | Parameterized supervisor unit tests |
| SIGTERM stops both children and restores the parent's signal handlers | Supervisor unit and real-process integration tests |
| A failed second spawn cleans up the first child | Supervisor unit test |
| A child ignoring graceful termination is killed after the shutdown limit | Supervisor unit test |
| Cancelling the supervisor cleans up its children | Supervisor unit test |
| Worker and API receive external mode and the expected CLI arguments | Supervisor unit and real-process tests |
| CLI returns the supervisor's exit code without constructing an HTTP app in the parent | CLI test |
| Provisioning installs the launcher, migration sequence, and background variables | Full deploy mock suite |
| Release alone upgrades a legacy backend and preserves custom settings | Full deploy mock suite |
| Default drain time is 35 seconds; an existing 90-second setting stays 90 | Full deploy mock suite |
| A bad selected source commit changes neither service config nor deployments | Full deploy mock suite |
| A connected-repository mismatch leaves backend configuration untouched | Full deploy mock suite |
| Existing idempotency, DNS, region, R2, secret preservation, and failed-release protections remain intact | Full deploy mock suite |

## Verification

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_backend_processes.py backend/tests/unit/test_cli.py backend/tests/unit/test_background_worker.py --cov=relay.processes --cov-report=term-missing -q
```

Result: **52 passed**, new supervisor **90% statement coverage** (58 statements).
Three cases start real subprocesses to exercise failure and signal forwarding.

```bash
bash deploy/tests/run.sh
```

Result: **all checks passed**, including both web hosting modes, fresh and
existing-service deployments, source validation, and rollback safeguards.
The suite uses local mock APIs and a Docker stub, not a live account.

`bash -n deploy/deploy.sh deploy/lib/railway.sh deploy/tests/run.sh` and
`git diff --check` passed.

```bash
UV_CACHE_DIR=.uv-cache uv run --offline --project backend --extra dev --with pytest-xdist pytest backend/tests -n 4 -q --tb=short
```

Result: **3066 passed, 8 skipped** in 217.87 seconds. The PostgreSQL worker
tests require an explicit test URL and were validated in the preceding
Procrastinate integration; the optional skips are unchanged.

## Limits

- No live deployment, push, image publication, or credential change was made.
  The Docker image was checked statically and through mock deployment tests;
  no production image build is claimed.
- Railway `/healthz` remains API liveness. Worker failure causes supervised
  service failure, but a successful deployment does not prove a periodic job
  has completed. Queue logs and database heartbeats remain the operator tools.
- The dependency audit reported the same existing AnyIO and virtualenv
  advisories recorded in `procrastinate.tdd.md`; no dependency changes are
  introduced by this deployment update.
