# Handoff redesign: source ownership revision

Journey: a recovery captured from one round must not replace a later round,
including when another admission finishes before this request reserves capacity.
An interrupted accepted recovery must remain replayable without a second round.

## RED evidence

- `70126185`: two API race tests admitted stale handoffs (202 instead of 409),
  with source replacement after capture and immediately before reservation.
- `d78b3bee`: added revision boundary and recorded-round retry coverage. Replaying
  a rejected idempotency key returned success instead of preserving its conflict.

## GREEN evidence

`uv run --project backend --extra dev pytest backend/tests/api/test_team_routes.py backend/tests/unit/test_work_scope.py -q --tb=short`

79 passed. Tests prove stale-source rejection, reservation release without
closing the newer session, no command publication, rejected-key replay, prepared
retry both before and after round persistence, legacy compatibility, revision
and round-ID mismatch, and malformed revision tokens (including booleans).

Broader regression/coverage run: 280 passed with
`backend/tests/unit/test_daemon_registry.py` added to those targets. Combined
statement/branch coverage is 82% for `relay.collaboration.service`, 80% for
`relay.daemon_registry.node_backend`, and 81% overall. All new ownership-check
lines are covered. The coverage command was:

```sh
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.daemon_registry.node_backend,relay.collaboration.service --data-file=/tmp/relay-ownership-coverage -m pytest backend/tests/unit/test_work_scope.py backend/tests/unit/test_daemon_registry.py backend/tests/api/test_team_routes.py -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-ownership-coverage -m
```

GREEN implementation checkpoint: `a03a565b`.

Full `npm test` passed: production build/typechecks, 1,406 TypeScript tests,
19 React tests, and 1,239 Python tests (153.23 seconds for the backend suite).

## Boundaries

The revision is a thread round token, not a task-wide ownership lease. Only
recovery admissions receive this token; legacy prepared manifests remain readable.
The check follows the durable active-session reservation so competing normal
admissions cannot advance the owner between check and round persistence. Direct
out-of-band event writes are not made safe by this check. Task edits and later
messages intentionally do not rewrite accepted receipts or increment this token.

Live file/hash validation and process termination fencing are separate follow-up
work. No live-agent or browser behavior evaluation was performed for this
backend admission change. Dependency audit reports the existing Next.js critical,
sharp high, and baseline-browser-mapping moderate advisories; no dependency edits.
