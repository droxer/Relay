# Backend review fixes

Source: the eight findings from the backend implementation review. The user
requested fixes; no separate plan file was supplied.

## Behavior and regression evidence

| User journey | Implementation | Regression coverage |
| --- | --- | --- |
| Browse the UI without exposing neighboring host files | Resolve paths and check ancestry instead of string prefixes | Encoded traversal and symlink escape return 404; public assets still load |
| Download the artifact produced by a remote daemon | Serve stored snapshots; remove backend-host reads and legacy collection walks | A colliding host file never overrides a snapshot; absent snapshots return 404; legacy completion does not collect host files |
| Download generated HTML/SVG safely | Attachment disposition, escaped filename, restrictive CSP | Both content types return attachment and sandbox headers with the original bytes |
| Provision only an authorized sandbox | Check the existing record's employee ownership | Cross-employee POST returns 403; owner POST succeeds |
| Receive PostgreSQL notifications | Preserve the password when rendering the connection URL | An escaped dummy password survives bridge construction |
| Complete/cancel a thread and its task together | Recover task links, exclude routine templates/deleted history, and join the shared database transaction | Mark done, cancel, cancellation endpoint, local-store compatibility, and injected-write rollback |
| Create a project before adding members | Nullable lead column and coordinated roster/lead updates | Empty creation, first member, last-member removal, PostgreSQL migration and guarded downgrade |
| Soft-delete an employee after archiving their projects | Guard only active projects | Active projects block deletion; archived history remains after deletion |

Primary tests: `backend/tests/api/test_backend_review_regressions.py`,
`backend/tests/api/test_project_routes.py`, and
`backend/tests/unit/test_schema_drift.py`. Daemon tests now send explicit
generated-file reports instead of relying on backend filesystem scans.

## TDD checkpoints

- `6ddef868`: the initial regression run produced **13 expected failures and
  18 passes**. Command:
  `uv run --project backend --extra dev pytest backend/tests/api/test_backend_review_regressions.py backend/tests/api/test_project_routes.py -q`.
- `6ef4b80c`: the additional legacy-host-scan regression failed as expected.
- `c4c30407`: the fixes passed **37 focused tests**, rerunning the initial
  targets plus `backend/tests/unit/test_controller.py`.
- Expanded final focused verification passed **241 tests**, including the
  regression, project, controller, daemon registry, and PostgreSQL schema suites.

These checkpoints are on the task branch. Preserve this evidence if squashing.

## Repository verification

- `npm test`: **1,359 TypeScript tests and 1,138 Python tests passed**, including
  package compilation and the production web build. The later local-controller
  regression was also validated in the final focused run.
- `uv run --project backend --extra dev pytest backend/tests/unit/test_schema_drift.py -q`:
  **3 passed**, exercising a scratch PostgreSQL schema, metadata comparison,
  migration data preservation, and downgrade refusal while an empty roster exists.
- `git diff --check`: passed.
- Python dependency audit: no known vulnerabilities in the installed backend
  dependencies; the local `relay` package is not published on PyPI and was skipped.
- npm dependency audit: **9 existing advisories** (6 high, 3 moderate), in
  unchanged dependencies. Dependency upgrades are separate from these fixes.

The instrumented backend run passed **1,139 tests** with **84% combined line and
branch coverage** across `relay` (15,242 statements and 5,342 branches).
Command:
`COVERAGE_FILE=/tmp/relay-review.coverage uv run --project backend --extra dev --with pytest-cov pytest backend/tests -q --cov=relay --cov-branch --cov-report=json:/tmp/relay-review-coverage.json --cov-report=term`.

## Deployment and compatibility

Apply Alembic revision `20260909_0067` before using empty project rosters against
an existing database (`make backend-migrate`). It makes `projects.lead_agent_id`
nullable without changing existing data. Downgrade requires assigning leads to
all empty projects first; it refuses to discard project data.

Artifact downloads now require stored content. Existing records without a
snapshot return 404 even if a same-named file exists on the backend host. Use the
owning daemon's live workspace browser for those files. Older daemons must
report generated files and content to create downloadable snapshots.

The HTML/SVG regression checks response disposition and CSP; it does not execute
the payload in a browser. No deployed multi-replica load test was performed.
Session/task rollback is guaranteed when the stores share the runtime database
engine; compatibility file stores do not provide cross-store atomic rollback.
