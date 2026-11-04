# Project task capacity and queued admission

## Intent and behavior

Derived from the user's review follow-up: fix WIP waits, global capacity visibility,
and abandonment; add a distinct Queued status; configure each user's task capacity
in the control panel, defaulting to five.

- Ready is `assigned`; a capacity refusal becomes `queued`, not `blocked`.
  The scheduler retries admission automatically. A preflight avoids creating
  conversations on every wait; transactional admission remains authoritative.
- Genuine dispatch failures retain manual retry, including historical retry
  records encountered while WIP is full. A stale preflight cannot overwrite an
  execution another request already admitted.
- Queued automation occurrences prevent duplicate firings. Cancellation releases
  the occurrence so later pending triggers may proceed.
- Admin → Users → Edit user exposes Concurrent task limit, default 5, range 1–100.
  Creation accepts the same setting. Null clears an override. All replicas read
  the database value at admission; reductions preserve admitted work and permit
  its continuations.
- Project-local activity and signed-in-user capacity are distinct. The global
  reading uses server-side occupancy before pagination and links across projects.
- Cancelled is an event-backed terminal outcome, distinct from accepted delivery.
  Cancellation checks linked execution truth, preserves history, and fences late
  results even after reopening, including legacy revision-zero executions.

The backend never executes agents. Admission still uses the existing task-store
transaction, user-scoped PostgreSQL advisory lock, and SQLite writer serialization.
No remote resources or running application databases were changed.

## RED checkpoints

Local checkpoint `a5dcd66a` adds the original reproductions. Runtime RED confirmed
WIP refusal blocked instead of queuing, cancellation was absent, and global usage
was missing. The new TypeScript cancellation test also produced the intended
compile-time RED (`cancelled` / `cancelledAt` were absent); only the package
TypeScript hook was skipped for this RED checkpoint. Final hooks run normally.

Subsequent reproductions were run before their fixes:

| Guarantee | RED evidence | Test area |
| --- | --- | --- |
| Queued is a distinct persisted status | Two WIP-wait cases failed on `assigned` | `test_blocked_execution.py` |
| Per-user capacity is configurable and bounded | Eight API cases failed: missing effective limit and invalid values accepted | `test_task_capacity.py` |
| Old WIP-only blocks are repaired without reviving real blocks | Missing repair implementation | `test_task_capacity_repair.py` |
| Late results cannot undo cancellation after reopening | Old result changed reopened work to Review | `test_task_kanban.py` |
| Legacy revision-zero results are also fenced | Legacy result changed reopened work to Review | `test_task_kanban.py` |
| Capacity cannot erase historical real failures or overwrite admission | Three race/policy cases failed | `test_blocked_execution.py` |
| A queued occurrence prevents duplicate automation runs | Next schedule fired a duplicate occurrence | `test_automation_trigger_boundaries.py` |
| User form defaults to 5 and saves its setting | Capacity field was absent | `userTaskCapacity.test.tsx` |

## GREEN verification

Commands were run from the repository root unless noted.

| Check | Command | Result |
| --- | --- | --- |
| Full backend suite | `npm run test:py` | 3,494 passed, 10 skipped; 798.03 seconds |
| Latest focused backend regressions, including cases added during review | `uv run --project backend --extra dev pytest backend/tests/unit/test_blocked_execution.py backend/tests/unit/test_task_kanban.py backend/tests/unit/test_task_capacity_repair.py backend/tests/unit/test_task_scheduler.py backend/tests/unit/test_task_dispatch.py backend/tests/unit/test_task_execution_ownership.py backend/tests/unit/test_automation_trigger_boundaries.py backend/tests/api/test_task_capacity.py backend/tests/api/test_task_kanban_routes.py -q` | 135 passed |
| Layering, module size, reducer isolation | Focused `pytest` on `test_layering.py`, `test_module_size.py`, `test_reducer_isolation.py` | Passed |
| Full built TypeScript suite and production build | `npm run test:ts` | Production build passed; 2,918 tests passed, 2 existing source-pattern failures |
| Full React suite | `npm run test:react -w web` | 789 passed across 135 files |
| Browser workflows | In `web/`: `npx playwright test -c playwright.recovery.config.ts taskKanban.spec.ts --workers=1` | 8 passed, including admin editing 5 → 2, desktop/phone capacity, queued/cancelled lanes, pointer and keyboard execution |
| Backend static checks | `uv run --project backend --extra dev ruff check backend`; in `backend/`: `uv run mypy` | Passed; mypy zero errors |
| TypeScript checks | `npx tsc -p packages/tsconfig.json --noEmit`; `npx tsc -p web/tsconfig.json --noEmit` | Passed |
| UI lint | ESLint on changed UI components and `taskCapacity.ts`; `npm run lint:css -w web` | Passed |
| Diff hygiene | `git diff --check` | Passed |

The full backend run completed while the later race/automation cases were being
added. The focused rerun above verifies the final implementations of those cases.

The two TypeScript failures are in unchanged tests/sources:

- `messageBlock.test.ts`: expects one `idempotencyKey:` occurrence in
  `useThreadDispatch.ts`; starting commit `d39c86d3` already has two.
- `taskBoardReviewFixes.test.ts`: expects an old `useKeyChange` hydration pattern;
  `BacklogPage.tsx` at the starting commit already lacks that pattern.

Both source files were compared byte-for-byte with the starting commit and remain
unchanged. Full frontend ESLint also reports an existing set-state-in-effect error
in unchanged `ComposerImages.tsx`, plus five existing warnings. Changed UI files
pass targeted ESLint. Dependency audit reports 33 existing findings (7 high,
25 moderate, 1 low); dependency manifests and lockfiles are unchanged.

## Coverage and visual inspection

Backend branch coverage was measured over capacity validation, SQL projection,
flow policy, execution fencing, dispatch failure classification, and startup
repair using `coverage run --branch` with the focused tests. Combined coverage:
**95%** (195 statements, 96 branches). New capacity validation, SQL helper, and
startup repair each have 100% coverage. This is scoped coverage, not a claim about
the whole backend.

Vitest V8 coverage over `ProjectDashboard`, `TaskCapacityField`, `taskFlow`, and
`taskCapacity` passed the configured 80% thresholds: **98.5% statements, 92.95%
branches, 95.65% functions, 100% lines**.

Playwright screenshots were inspected at desktop and 390px phone widths for the
project capacity reading and admin edit form. Impeccable's mechanical detector
reported no findings for the changed dashboard/status surfaces or admin controls.

## Data, rollout, and limitations

- `20261104_0111` replaces the dispatch index to include `assigned` and `queued`.
  PostgreSQL builds the replacement concurrently inside an autocommit block before
  dropping the old index. SQLite upgrade/downgrade and history preservation passed.
- `20261104_0112` adds nullable `users.max_concurrent_tasks`. Existing users inherit
  the server default of five; overrides are lost on downgrade. SQLite round-trip
  column checks passed.
- Run `make backend-migrate` before deploying matching backend and web readers.
  Older readers do not understand Queued/Cancelled. No live migration or deployment
  was performed as part of this code change.
- The startup repair only requeues unadmitted blocks whose recorded cause is WIP;
  it preserves human blocks and execution failures. `RELAY_STARTUP_REPAIRS=0`
  disables it with the other startup repairs.
- PostgreSQL-only tests were skipped because no test database was configured;
  the concurrent index replacement was not exercised against a live PostgreSQL
  server in this run.
