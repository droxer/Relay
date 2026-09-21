# Project setup, editing, and execution fixes

Date: 2026-09-22. Source: the project setup/edit/execution review and the user's
instruction to fix all six findings, one by one. No migration or deployment is
required. Changes are committed locally; nothing was pushed.

## Behavior and ownership

| Finding / user journey | Final behavior | Primary implementation |
| --- | --- | --- |
| Keep a name draft while another client updates the project | The editor retains its draft and original revision until closed or saved | `web/src/components/ProjectDrawer.tsx` |
| Repair a roster containing several unhealthy agents | Existing members can be edited, disabled, or removed incrementally. New members, reactivation, and lead changes still require readiness; ownership and roster structure remain validated | `backend/relay/services/project_catalog.py` |
| Run a task with the selected project agent | Manual starts, scheduled starts, and routine runs use the explicit enabled member. Unassigned tasks retain whole-roster execution | `backend/relay/services/project_runtime.py`, `backend/relay/api/task_routes.py` |
| Keep closed projects read-only | Task/thread creation, public task mutation/deletion/assignment/start/pickup, and routine promotion reject closed projects. Routine schedules do not advance. Reads and completion events from admitted runs remain supported | `backend/relay/api/project_helpers.py`, task/session routes, project runtime, task dispatch, scheduler |
| Rename a project without its runtime node in the list | Computer selection is required for creation, not metadata edits | `web/src/components/ProjectDrawer.tsx` |
| Recover a stale project/member save | Fetch the latest project, merge only edited fields, show overlapping values, and request confirmation before one retry. Preserve other members, their edits, and concurrent removals. Cancellation or failure keeps the draft; edited members removed remotely are not resurrected | `web/src/lib/projectEdit.ts`, `web/src/hooks/useProjectSave.ts`, both project editors |

Conflict retry includes member removal and settings renames. A second conflict
stops with an inline message; it does not retry indefinitely. The shared mutation
handler leaves version conflicts to this flow instead of showing a misleading
computer/roster failure toast. Conflict copy is provided in English, Simplified
Chinese, and Traditional Chinese.

## RED and GREEN evidence

Tests were added and run before the corresponding fixes. Checkpoint commits are
on the current branch and remain separate.

| Stage | RED evidence | GREEN evidence / checkpoints |
| --- | --- | --- |
| Draft preservation | Expected `Unsaved`, received the concurrent saved name | `projectSettings.test.tsx`; `925fdcab` → `0a57ad87` |
| Roster repair | Three cases rejected with `project_member_disabled` or `project_member_computer_mismatch` | Seven catalog tests plus 21 existing project API tests passed; `d2a87ccb` → `eda026f7` |
| Explicit assignment | Manual/routine dispatch blocked on an unselected disabled lead; disabled roster members were accepted for task assignment | Five assignment API cases passed, covering manual/scheduler/routine and create/update validation; `0b3dcbf0` → `bda3775b` |
| Lifecycle | Four closed-project cases accepted writes or promoted a routine | Project policy and existing task API suites: 61 passed, including daemon completion after closure; `27c77298` → `9a3f63f4` |
| Missing runtime | Rename never invoked the mutation | Four settings tests passed, including creation still requiring a computer; `ca9f9625` → `cb6155d5` |
| Conflict recovery | Five interaction cases had no retry, confirmation, or actionable error | 30 interaction/merge tests passed; `8f6111e0` → `4e1a0360` |
| Browser/edge checks | Browser recovery displayed an incorrect failure toast; overlapping lead edits showed raw IDs and an untranslated field | Two focused browser journeys passed; final focused suite: 38 passed. Additional tests cover declined confirmation, network failure, repeated conflict, concurrent additions/removals, instruction clearing, lead changes, and project closure |

Representative commands actually run:

```sh
npm run test:react -w web -- interaction-tests/projectSettings.test.tsx
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_project_catalog.py backend/tests/api/test_project_routes.py -q
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_project_execution_policy.py backend/tests/api/test_project_routes.py backend/tests/unit/test_project_runtime.py -q
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_project_execution_policy.py backend/tests/api/test_tasks.py -q
npm run test:react -w web -- interaction-tests/projectDraft.test.tsx interaction-tests/projectSettings.test.tsx interaction-tests/projectEdit.test.tsx
npm test
npm run build -w web
npm run test:react -w web
```

The scheduled-assignment test explicitly sets `status: assigned`: Backlog tasks
are intentionally not picked up by the scheduler.

## Verification

- `npm test`: passed. Production builds and TypeScript compilation passed;
  1,684 compiled TypeScript tests, 256 React tests, and 1,783 Python tests passed.
- After additional failure-path tests and the conflict-toast fix, the full React
  rerun passed 263 tests. The subsequent lead-label regression passed in the
  final focused 38-test run and TypeScript pre-commit check.
- Final focused UI coverage, using Vitest V8 with includes for `ProjectDrawer`,
  `ProjectMemberEditor`, `useProjectSave`, and `projectEdit`: statements 88.27%,
  branches 85.38%, functions 83.54%, lines 91.36%. All aggregate thresholds passed.
- Focused Python coverage with pytest-cov: 41 tests passed; 89% statement coverage
  across project routes/helpers/catalog/runtime. Individual modules: 92%, 94%,
  83%, and 95%, respectively. This is focused coverage, not whole-backend coverage.
- Playwright: first-project creation preserving the task draft, and rename with
  no runtime plus conflict confirmation, both passed (2/2). API responses were
  intercepted; these browser tests do not execute real agents.
- `git diff --check` and repository pre-commit checks passed.

The browser command used a freshly allocated local port and `CI=1` to prevent
Playwright from reusing another worktree's server:

```sh
# From web/, with RELAY_E2E_PORT set to an unused local port:
CI=1 ../node_modules/.bin/playwright test -c playwright.recovery.config.ts projectTasks.spec.ts -g 'renaming without|creating the first'
```

## Invariants and scope

- The backend still queues work for daemons; it does not execute agents.
- Task/session events and project event-backed updates remain authoritative.
- Project workspace paths, stable computer bindings, and the daemon workspace
  gate are unchanged. Selected-agent runs retain the project workspace.
- Closed-project checks are applied after access checks. Existing owner checks,
  task deletion authorization/idempotency, and result recording remain intact.
- No database schema, credentials, user configuration, or dependencies changed.
- Name-only/deferred-computer setup and mandatory project ownership for every
  legacy/backend task producer remain separately planned features, outside the
  six reviewed defects.

## Remaining verification limits

Two existing desktop/mobile `projectTasks.spec.ts` navigation scenarios still
fail on their assertion that no dialog exists after task navigation: the current
UI opens the task record in a drawer. Those task-record components were not
changed here. The passing focused browser journeys above are reported separately;
the complete project browser file is not green.

The first browser attempts reused other worktrees' servers on ports 5124 and
5137. Results from those servers were discarded, and subsequent tests used an
isolated port. One jsdom-only attempt to exercise the real Select hung; that
component test uses the existing native-select mock pattern, while Playwright
covers the real computer picker.

`npm audit --registry=https://registry.npmjs.org` reported zero vulnerabilities.
The configured npm mirror lacks an audit endpoint. `uvx pip-audit --path
backend/.venv/lib/python3.14/site-packages` reported two advisories for the existing
`anyio 4.13.0` installation (CVE-2026-63374 and CVE-2026-64847; suggested fixed
version 4.14.2). Relay itself is local and could not be audited against PyPI.
Dependency remediation is separate from these fixes.

Real BoxLite/agent execution and cross-process races between project archival
and another aggregate's mutation were not exercised. The changes add admission
checks; they do not introduce a cross-aggregate database transaction.

## Integration with current main

Merged `main` at `d58a598b` for PR #281. Preserved the new permanent-deletion
controls and archive endpoint alongside draft preservation and bounded conflict
retry. Member conflict labels now use agent display names because main removed
member function titles; regression fixtures use responsibilities and instructions.

After resolution, `npm test` passed: production builds and TypeScript compilation,
1,688 compiled TypeScript tests, 267 React tests, and 1,803 Python tests. Focused
checks also passed: 41 UI tests and 38 backend project policy/catalog/deletion
tests. `git diff --check` passed. Browser tests were not rerun for this merge.
