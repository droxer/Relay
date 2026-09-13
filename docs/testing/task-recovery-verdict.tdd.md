# Task recovery verdict regression

Journeys were derived from the handoff review: recovering a task-backed thread
must retain its completion policy, preserve routine templates, and avoid
choosing arbitrarily between multiple linked tasks.

## RED

`uv run --project backend --extra dev pytest backend/tests/api/test_team_routes.py -k task_recovery_preserves -q`

All eight cases failed before the fix. In particular, exit code 0 without a
verdict marked the task `done` instead of `waiting_for_human`. The failing-test
checkpoint is `39f12438`. The additional ambiguous-link test failed because
recovery returned 202 instead of 409.

## GREEN

`uv run --project backend --extra dev pytest backend/tests/api/test_team_routes.py -k 'task_recovery_preserves or ambiguous_task_links' -q --tb=short`

Nine cases passed. Both handoff and rerun preserve missing/done/continue/blocked
verdict behavior. Continuation keeps the session ID; routine templates are
unchanged; completed-request replay makes no further task mutations; ambiguous
links fail before an agent run is created.

## Coverage

`uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.collaboration.service --data-file=/tmp/relay-handoff-coverage -m pytest backend/tests/api/test_team_routes.py -q --tb=short`

55 API tests passed. `coverage report` on that data file reports 80% combined
statement/branch coverage for the collaboration service, with no added recovery
lines listed as missing. These tests exercise HTTP admission, database events,
daemon command delivery, and terminal-result processing without invoking a real
agent CLI.
