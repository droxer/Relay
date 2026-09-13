# Task ownership: exclusive active reservation

Journey: two threads, nodes, or backend replicas cannot independently own an
active execution request for the same task. A superseded terminal request cannot
reactivate over a replacement. Reference links must not reserve task ownership.

## TDD checkpoints

- `2d4dd849` RED: four cross-node races admitted both requests; three terminal
  requests could revive over a replacement (7 failed, 1 passed).
- `5665a090` GREEN: database active-task uniqueness and conflict translation;
  all eight reservation cases passed. Migration refuses duplicates without
  mutation, supports null task IDs and terminal history, and has a downgrade.
- `e2a45e28` RED: expanded tests to the supported local store; three revival
  cases failed while eleven cases passed.
- `cef623c6` GREEN: local creates and transitions share a reentrant process-level
  claim lock. All 216 daemon-registry tests passed, including both-store races,
  idempotency, terminal release, and stale revival rejection.

## Verification

```sh
uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py -q --tb=short
uv run --project backend --extra dev pytest backend/tests/unit/test_active_task_reservation_migration.py backend/tests/unit/test_schema_drift.py backend/tests/api/test_team_routes.py -k 'migration or migrated_schema or recovery_cannot_take' -q --tb=short
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.persistence.daemon_store --data-file=/tmp/relay-task-reservation-cov -m pytest backend/tests/unit/test_daemon_registry.py backend/tests/unit/test_active_task_reservation_migration.py backend/tests/unit/test_schema_drift.py backend/tests/api/test_team_routes.py -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-task-reservation-cov -m
```

The migration/API selection passed 8 tests, including the real PostgreSQL schema
drift check. The broader final coverage run passed 297 tests with 82% combined
statement/branch coverage in `relay.persistence.daemon_store`. The API regression
proves a losing recovery leaves the existing owner active, adds no session events,
does not change task status, and publishes no command.

`npm test` passed the production build, 1,434 TypeScript tests, 19 React tests,
and 1,259 backend tests. The local-store transition change was verified separately
in the final 297-test regression run. The final full backend rerun,
`npm run test:py`, passed all 1,266 tests in 147.58 seconds after that change.

## Deployment and remaining scope

Migration `20260913_0068` must be applied to database deployments. Pause admissions
and resolve duplicate active task requests before upgrading; the migration neither
cancels requests nor rewrites authoritative events. Only scratch test schemas
were migrated during this work, not the running application database.

This is exclusivity for active request reservations, not a monotonic task revision
token or a physical-process lease. A terminal cancellation may precede process
exit; old daemons and external writers still require stronger fencing. Internal
assignments within the owning request may collaborate normally. Existing local
duplicates likewise need operator resolution; no live writer is silently retired.

No UI or live-agent evaluation was performed. Dependency audit continues to report
the existing Next.js critical, sharp high, and baseline-browser-mapping moderate
advisories; dependencies were not changed.
