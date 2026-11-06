# Project manager implementation evidence

The [feature design](../project-manager-design.md) supplies the journeys: every
Project has a durable default manager, answers use live Project records, and
task changes are proposed in conversation and applied by the owner. Backend
execution continues through the ordinary conductor and daemon queue.

## Behavior and ownership

- `projects/manager.py` selects an eligible manager, preserves its binding,
  checks availability, and ensures one canonical Thread. Project creation
  accepts an explicit choice; the startup repair initializes existing Projects
  without creating Threads or starting runs. Manager and lead remain separate.
- `projects/manager_reads.py` exposes current overview, task records, review
  evidence, activity, and Thread messages with scope checks and coverage. The
  overview uses a consistent database read scope; pagination is deterministic.
- `projects/manager_proposals.py` stages typed changes. The owner can select
  and edit operations before a transaction applies them through existing Task
  domain operations. Revision checks, prerequisite validation, and persisted
  application keys protect against stale edits, partial changes, and retries.
- `persistence/project/manager.py` stores proposal projections and proposal
  events. Bindings live in Project snapshots/events. Alembic revision
  `20261106_0113` adds the two proposal tables, their index, and constraints.
- The daemon's `project-manager.ts` provides a real Node command helper in
  each active run. Credentials remain outside the workspace. Every backend
  request checks node authentication, command lease, active run, and Project
  scope; local workspace tools are authorized through the same check first.
- The project header and Dashboard open the manager without a model call.
  The panel reuses transcript, permission, recovery, and resize components.
  Mobile uses the existing modal surface to contain focus; desktop supports
  pointer and keyboard resizing. Proposal cards preserve Apply errors and use
  stable retry keys. English and Chinese copy are provided.

## TDD evidence

The first backend tests ran before production code and failed with four 404
responses for missing manager routes. Commit `c3ec50d7` records that RED gate.
The same four scenarios passed after implementation in `e1dc72e4`.

The daemon test initially failed compilation because `project-manager.js` did
not exist. The UI test initially failed import resolution for the missing panel.
Both targets then passed after implementation. A later readback test exposed a
real gap: Thread messages were being read from a nonexistent `messages` field.
It failed before the tool was changed to reconstruct messages from authoritative
Thread events and Agent reports; the corrected test passes. A final update-feed
regression also failed before Project changes and Agent reports were added to
the paginated activity feed alongside Task events.

The final API suite has 16 scenarios, covering defaults, explicit choice,
idempotent legacy backfill, crew isolation, canonical Thread reuse, live reads,
task creation/editing, subset apply, retry identity, concurrent creation/apply,
stale revisions, cycle rollback, Project isolation, daemon-token limits, bad
leases, pagination, unavailable Agents, disabled Projects, and archived history.

## Verification results

Commands ran from the repository root unless stated otherwise.

| Check | Command or target | Result |
| --- | --- | --- |
| Full Python suite | `uv run --project backend --extra dev pytest -q --tb=short` | 3,629 passed, 10 skipped |
| New API scenarios on PostgreSQL | `RELAY_TEST_STORE_BACKEND=postgres` with `backend/tests/api/test_project_manager_api.py` | 16 passed |
| PostgreSQL migration and schema checks | `backend/tests/unit/test_schema_drift.py` against a temporary local PostgreSQL 17 instance | 17 passed |
| Manager backend coverage | The API scenarios with `pytest-cov` over the manager API, domain, persistence, and startup repair modules | 84% aggregate statement coverage |
| Shared TypeScript suites | Built `relay-core`, daemon, supervisor, and `web/tests` with `node --test` | 2,938 passed |
| React interaction suite | `npm run test:react -w web` | 824 passed |
| Browser workflows | `npm exec -w web -- playwright test -c playwright.recovery.config.ts projectManager.spec.ts` | 3 passed: desktop English, mobile English, mobile Chinese dark mode |
| Production build | `npm run build`, followed by the final web production build | Passed |
| Backend lint and types | `ruff check backend`; backend `mypy` | Passed; zero type errors |
| Frontend lint | `npm run lint -w web`; `npm run lint:css -w web` | No errors; three existing ESLint warnings outside manager code |
| Dependency audit | `npm audit --registry=https://registry.npmjs.org --package-lock-only --omit=dev --audit-level=high` | Zero reported vulnerabilities |
| Diff hygiene | `git diff --check` | Passed |

The full Python suite ran before the final four additive feature tests; those
16 feature scenarios were subsequently verified on both SQLite and PostgreSQL.
Focused UI checks and browser flows were rerun after layout refinements.

Browser tests exercise opening without dispatch, editable prompt selection,
sending, reload persistence, editing, owner Apply, backlog preservation, Back
navigation, viewport bounds, and desktop keyboard resizing. API responses are
fixtures in those browser tests. Backend tests exercise real stores and daemon
command admission; daemon tests execute the actual helper process. Shared
command-builder checks prove the manager tool contract reaches all five Agent
Runtimes. These checks do not launch authenticated third-party model sessions.

## Rendered evidence

These captures use test fixtures, not production records. The desktop and mobile
Chinese captures were inspected for layout, contrast, readable controls, and
composer reachability.

- [Desktop manager](../images/project-manager-desktop.png)
- [Mobile manager](../images/project-manager-mobile.png)
- [Chinese dark mode](../images/project-manager-mobile-zh-CN.png)

## Rollout

Run the normal backend migrations before starting this version, and install the
rebuilt computer client to advertise `project-manager`. Older clients display
an update action instead of accepting manager runs without tools. Task creation
through Apply stays in backlog; Start, Wait, Task Review, cancellation, and
execution reconciliation continue through their existing dedicated flows.
