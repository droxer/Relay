# Handoff cancellation: retain delivered ownership

Journey derived during implementation: cancelling a thread must not free its
task reservation merely because the user-facing session is terminal. A queued
command may be suppressed, but a delivered command may still be executing.

## Checkpoints

- `22ba79e0` RED: direct cancellation prematurely released delivered reservations
  in both stores (2 failed, 2 passed).
- `79b9ee50` GREEN: compare-and-set accepts `require_undelivered`; delivery is
  checked under the local claim lock or database request-row transaction used
  by publication and polling (4 passed).
- `1730e4e3` RED: terminal-session reaping still released those reservations,
  including expired command leases (4 failed, 2 passed).
- `855c7c05` GREEN: reaping uses the same delivery guard (6 passed).

The test target is
`backend/tests/unit/test_daemon_registry.py::test_cancel_before_delivery_preserves_delivered_task_reservation`.
It covers local and database stores, queued suppression, delivered reservation
retention, expired leases, and background reaping after session cancellation.

## Verification

```sh
uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py -q -k cancel_before_delivery_preserves --tb=short
```

The six cases pass. The final broader run, after the reaper fix, passed 330
registry, team-route, and task API tests in 41.70 seconds, with 83% combined
statement/branch coverage of the daemon store:

```sh
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.persistence.daemon_store --data-file=/tmp/relay-cancellation-final-cov -m pytest backend/tests/unit/test_daemon_registry.py backend/tests/api/test_team_routes.py backend/tests/api/test_tasks.py -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-cancellation-final-cov
```

Dependency audit still reports three existing advisories (one moderate, one
high, one critical); no dependencies were changed.

`npm test` passed production builds, 1,434 TypeScript tests, 19 React tests, and
1,272 Python tests (157.27 seconds for Python). That process started before the
final reaper edit; the 330-test coverage run above verifies the final backend
change. `git diff --check` passed. RED/GREEN commits remain on the active branch.

## Limits

This closes two early-release shortcuts, not every process-fencing path. Node
retirement, other synthetic terminal events, late-result mutation, crash recovery
of terminal acknowledgements, and monotonic task ownership revisions still need
the next lifecycle slice. A cancellation request or expired lease is not proof
of physical process exit. No live daemon/process test or browser E2E was run for
this backend-only change. Existing daemon acknowledgement behavior is unchanged.

No migration or public protocol change is introduced by this slice. The earlier
active-task uniqueness migration remains required for database deployments.
