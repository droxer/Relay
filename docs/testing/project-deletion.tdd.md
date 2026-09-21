# Project deletion verification

The journey comes from the request to let a user delete a project and its owned
contents. The project owner confirms deletion in Project settings; active work
must stop first. Archive remains a separate operation.

## Ownership and behavior

- `api/project_routes.py` authorizes the owner and validates the expected version.
- `services/project_deletion.py` locks the project, tasks, and sessions; removes
  project records and owned histories; and queues execution-plane file cleanup.
- Existing session deletion unlinks surviving tasks and preserves standard audit
  and usage retention. Shared agents, computers, and other projects survive.
- Database daemon commands join the deletion transaction. Local commands are
  gated on committed project absence, protecting files after rollback or crash.
- The daemon accepts only the canonical project root, rejects symlink roots,
  and repeats cleanup safely if acknowledgement is lost.
- The web mutation removes project/task/session cache entries, clears related
  detail caches, and returns to the project directory after confirmation.
- No schema migration. Older daemons defer file cleanup until updated. Files
  are removed asynchronously when the owning computer polls; the response and
  UI explicitly report queued cleanup.

## RED / GREEN evidence

- RED checkpoint: `72447622` adds the cascade and filesystem regressions.
  `npx tsc -p packages/tsconfig.json` reported missing `deleteProject`; executing
  the emitted workspace tests failed on the missing method. The compile hook
  was skipped only for this intentionally failing test checkpoint.
- GREEN: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest
  backend/tests/api/test_project_deletion.py -q`: **20 passed**, covering both
  daemon storage modes, owned event/artifact removal, routine occurrences,
  unrelated records, archived projects, authorization, optimistic versions,
  active execution, queue failure, rollback, and cleanup acknowledgement.
- `node --test --test-name-pattern='project workspace|project deletion|archives
  the exact|permanently deletes' dist/packages/relay-daemon/tests/daemon.test.js
  dist/packages/relay-daemon/tests/thread-workspace.test.js dist/web/tests/api.test.js`:
  **9 passed**, including repeated cleanup delivery and directory isolation.
- `npm run test:react -w web -- --run interaction-tests/projectDeletion.test.tsx`:
  **3 passed**, covering cancel, confirm/navigation, and failure preserving settings.
- Coverage for `relay.services.project_deletion`: **88%** (coverage.py).

## Broader verification

- `npm test` completed the production build; its first test pass exposed an
  inherited Kimi configuration-home override in an existing inventory test.
- `env -u KIMI_CODE_HOME -u CODEX_HOME node --test
  dist/packages/relay-core/tests/*.test.js dist/packages/relay-chat/tests/*.test.js
  dist/packages/relay-daemon/tests/*.test.js dist/packages/relay-supervisor/tests/*.test.js
  dist/web/tests/*.test.js`: **1,706 passed**. Includes CLI rendering and Pi compatibility.
- `npm run test:react -w web`: **238 passed** across 37 files. One earlier roster
  test timed out; it passed independently and on the complete-suite rerun.
- `npm run test:py`: **1,775 passed**. The expanded storage-mode deletion tests
  were also rerun separately after this suite collected its tests.
- `npx tsc --noEmit -p web/tsconfig.json` and package compilation passed.
- `npm audit --registry=https://registry.npmjs.org`: **0 vulnerabilities**.
  The configured mirror does not implement the audit endpoint.
- `git diff --check`: clean.

The UI verification uses jsdom interaction tests, not a live-browser E2E run.
The database-mode tests use SQLite; no live PostgreSQL concurrency run was made.


## Follow-up: older daemon compatibility

The reported `project_cleanup_unavailable` error reproduced in both storage modes
when the owning Computer advertised `project-workspaces` but lacked the newly
added `project-workspace-delete` capability. Requiring the capability at deletion
time unnecessarily blocked all record cleanup during a rolling upgrade.

The service now keeps a durable cleanup command and returns
`workspaceCleanup: "waiting_for_upgrade"`. The registry withholds the command
from older daemons and delivers it after a capable runtime registers. The UI
warns explicitly that files remain pending an update and reconnection. Missing
Computer registrations still fail without removing records.

- RED checkpoint `777ea426`: both compatibility regressions returned 409.
- GREEN: project deletion/routes and daemon registry tests: **296 passed**.
- Cleanup notice/cache and deletion-confirmation interaction tests: **5 passed**.
- Updated deletion service coverage: **89%**.
- Regression verifies that the same durable job survives incompatible polls and
  reaches the upgraded daemon in both file-backed and database-backed storage.
- Full `env -u KIMI_CODE_HOME -u CODEX_HOME npm test` passed: **1,706 TypeScript,
  238 React, and 1,787 Python tests**. The two added cleanup-notice tests also
  passed separately after the full React suite had collected its files.
- Dependency audit: **0 vulnerabilities**; `git diff --check` clean.
