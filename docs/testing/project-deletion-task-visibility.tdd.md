# Deleted-project task visibility

User journeys derived from the reported bug: deleted-project tasks must disappear
from Tasks, and project deletion must clean up its owned records atomically.

## Regression evidence

- RED: `uv run --project backend --extra dev pytest backend/tests/api/test_project_deletion.py -q -k 'prerequisites_counters or missing_project'`
  produced three expected failures: leftover project counter and orphan tasks
  visible in both full and summary responses with `limit=1`.
- GREEN: project deletion, task store, and project concurrency tests passed:
  60 passed, 1 skipped (PostgreSQL concurrency requires its configured database).
- Related task/project API and unit tests: 447 passed, 2 skipped.
- Architecture and module-size checks were included in the focused verification.
- Notification regression was separately run RED: project, task, and thread
  notices remained visible after deletion.
- Final GREEN after notification cleanup: project-deletion, architecture, and
  module-size checks passed (33 tests). Ruff and mypy passed (387 source files).

## Guarantees

`backend/tests/api/test_project_deletion.py` covers:

- Missing-project tasks are excluded before the limit in full and summary lists.
- Project tasks, routines, occurrences, threads, history, artifacts, and membership
  are removed, while unrelated tasks, projects, agents, and computers survive.
- Prerequisite links, project counters, and pending automation events are removed.
- Automation secrets and state roll back when workspace cleanup cannot be queued.
- Notifications for deleted work disappear; unrelated notices remain.
- Active execution still blocks deletion; linked directories remain on disk.

## Limits

The full backend run was interrupted after sandbox restrictions caused three
installer `/dev/tty` failures (382 tests had passed). All 24 installer tests passed
when rerun outside the sandbox. The complete backend and TypeScript suites were
not completed. No coverage percentage was measured; the environment does not
include a coverage runner. Legacy orphan rows are hidden by reads, not purged from
an existing deployment. File deletion remains a durable daemon command and may
wait for the computer to reconnect or upgrade.
