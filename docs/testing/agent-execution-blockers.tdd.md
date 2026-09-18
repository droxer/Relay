# Execution blocker fixes — TDD evidence

The seven guarantees below come from the user's request to fix the
[execution blocker review](agent-execution-blockers-review.md). No separate
plan file was supplied.

## Behavior and ownership

| User-visible guarantee | Implementation | Regression evidence |
| --- | --- | --- |
| A completed run does not reject its successor while its HTTP response is delayed | Daemon execution returns a terminal event; workspace serialization ends before terminal delivery. Retained terminal events do not consume execution slots. | `daemon.test.ts`: `blocker: terminal delivery does not occupy a process or workspace slot` uses one slot and the same workspace for both runs. |
| Healthy short leases survive heartbeat or poll renewal | Heartbeat cadence is capped at one third of the requested lease. Polls return matching lease observations and server processing time. Daemons verify lease identity and account for transport latency separately from long-poll waiting. | `daemon.test.ts`: four `blocker: short execution leases validate ...` cases cover heartbeat renewal, heartbeat outage with poll renewal, a long poll, and rejection of another lease's evidence. Daemon API tests exercise the actual response contract. |
| An admitted continuation waits for capacity without restarting earlier assignments | Registry leaves the current assignment undelivered and preserves the request, task ownership, index, and workspace. Periodic recovery dispatches it when capacity returns. | `test_capacity_loss_queues_only_the_undelivered_assignment`, local and SQLite. |
| Expiry does not start another process with unconfirmed ownership | Both stores exclude dispatched `run.start` from redelivery and queue counts. Original lease evidence remains valid for finalization. | `test_expired_run_keeps_lease_and_accepts_saved_terminal`, local and SQLite; API and cross-replica lease tests. |
| Pending stops can reach the daemon even behind expired starts | Expired starts are excluded before the query's limit. Cancel/workspace delivery retries remain leased. | `test_expired_starts_do_not_starve_cancellation_page`, ten starts and ten cancels, local and SQLite. Existing non-executing-command retry/fencing tests remain. |
| A failed task write does not leave running work with no execution | Session failure uses the shared transaction; replay idempotently repairs missing blocked transitions under the original task execution owner. | `test_failed_task_projection_recovers_after_storage_error`, local and SQLite using shared session/task engines for the latter. |
| A disabled executor does not leave an ambiguous dispatch claim | Placement selection excludes disabled runtimes; final admission raises a classified rejection if disabling races selection. | `test_disabled_executor_does_not_retain_dispatch_claim` and `test_executor_disabled_after_routing_releases_known_rejected_claim`, each with local and database tasks. |

All task transitions continue through authoritative events. The backend only
dispatches commands; execution remains in the daemon. No schema migration,
credential change, or live-task rewrite is included.

## RED and GREEN checkpoints

- RED `d4943030`: new tests compiled. Python reported **10 failed, 20 passed**;
  the three original full-daemon regressions all failed for their intended
  symptoms. Both `npm audit` (official registry) and `pip-audit` reported no
  known vulnerabilities before committing.
- GREEN `07731a8e`: **33 focused Python tests** and **five daemon regression
  tests** passed. The additional tests cover a disabling race, long-poll
  timing, and wrong-lease observations. The resumed-capacity test was completed
  with `run.executing` events before checking its agent-run projections.
- Existing assertions that required automatic run redelivery or terminal
  failure on capacity loss were updated to the corrected contract. Stale lease
  rejection, non-executing delivery retries, and confirmed-exit requirements
  remain tested. ADR-010 and the API documentation were updated accordingly.
- Additional RED `e801dd3d`: a delayed poll observation replaced a newer
  heartbeat grant and stopped the process prematurely. The ordering regression
  executed against the old implementation and failed at runtime.
- Additional GREEN: the watchdog now ignores older server observations.
  TypeScript compilation and all **164 daemon tests** passed, including the
  ordering regression and all five full-daemon blocker cases.

Focused commands:

```sh
uv run --project backend --extra dev pytest backend/tests/unit/test_execution_blocker_regressions.py backend/tests/unit/test_blocked_execution.py -q
npx tsc -p packages/tsconfig.json
node --test --test-name-pattern='blocker:' dist/packages/relay-daemon/tests/daemon.test.js
```

## Final verification

- `npm test` passed the package and web production builds, **1,549 Node tests**,
  **82 React tests in 21 files**, and **1,692 Python tests**. This full run
  preceded the additional ordering fix; the subsequent TypeScript compile and
  164-test daemon suite cover that final change.
- A separate coverage run passed **449 Python tests** covering registry, daemon
  API, blocker regressions, routing, placements, controller, and task ownership.
  Combined statement coverage of the six changed backend modules was **83%**
  (3,926 of 4,714 statements). Individual modules ranged from 74% to 87%.
- `node --experimental-test-coverage --test dist/packages/relay-daemon/tests/*.test.js`
  passed 164 tests. Daemon runtime line coverage was **91.36%**; watchdog line,
  branch, and function coverage was **100%**. All imported files together,
  including core modules outside this fix, had 71.10% line coverage.
- `npm audit --registry=https://registry.npmjs.org --json` and
  `uv run --project backend --with pip-audit pip-audit --local` reported **zero
  known vulnerabilities**. `git diff --check` passed.

Backend coverage command:

```sh
uv run --project backend --with coverage --extra dev python -m coverage run \
  --data-file=/tmp/relay-blockers.coverage \
  --source=relay.api.daemon_node_routes,relay.daemon_registry.registry,relay.daemon_registry.node_backend,relay.persistence.agent_placement_store,relay.persistence.daemon_store,relay.sessions.controller \
  -m pytest backend/tests/unit/test_daemon_registry.py backend/tests/api/test_daemon_api.py \
  backend/tests/unit/test_execution_blocker_regressions.py backend/tests/unit/test_blocked_execution.py \
  backend/tests/unit/test_agent_routing.py backend/tests/unit/test_agent_placements.py \
  backend/tests/unit/test_controller.py backend/tests/unit/test_task_execution_ownership.py -q
uv run --project backend --with coverage --extra dev python -m coverage report --data-file=/tmp/relay-blockers.coverage
```

## Operational limits

Deploy the backend before the updated daemon. Additional response fields are
compatible with older clients. A lost start response or crashed daemon may
remain unconfirmed until terminal evidence or host reconciliation is available;
it is no longer automatically rerun on lease expiry. This is intentional and
does not provide exactly-once external side effects.

Regression scenarios use real stores, registry transitions, API handlers, and
the daemon loop, with controlled transport/executor fixtures and injected
storage failures. They do not launch external agent CLIs or a live multi-host
deployment. Browser E2E was not added because these changes do not alter UI
interaction paths.
