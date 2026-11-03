# GitHub issue import review fixes

## Scope and guarantees

Derived from the four review findings, without a separate source plan:

- Concurrent imports of the same issue into one project or one user's intake
  create one task; the other request reports `already_imported` with its id.
- An imported description retains issue content beyond 20,000 characters.
- Selecting all from more than 50 loaded issues selects a capped batch; clicking
  again clears it. Rendering and toggling share the same selection predicate.
- Migration 0107 accepts an already-committed `external_ref` column, builds the
  missing index, tolerates another retry, and still downgrades. Fresh installation
  is covered too.

Import admission stays in `create_task`. The task store rechecks the destination
and external reference under `resource_transaction`, using the existing SQLite
writer reservation or PostgreSQL advisory transaction lock. The lock covers only
the database operation, after the GitHub read, and task events remain authoritative.

## RED and GREEN

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_github_issue_import.py backend/tests/unit/test_task_external_ref_migration.py -q
npx tsc -p packages/tsconfig.json
node --test dist/web/tests/githubImport.test.js
```

- Backend RED: 3 failed, 15 passed. The failures demonstrated two created tasks
  for simultaneous imports, truncated description content, and a duplicate-column
  exception when resuming the migration.
- Frontend RED: 1 failed, 5 passed; the second select-all click retained 50 issues.
- Backend GREEN: 20 passed after adding both project/intake concurrency cases and
  fresh/resumed migration cases. Frontend GREEN: all 6 tests passed.
- No checkpoint commits were created; the feature was already an uncommitted
  working-tree change when review and repairs began.

## Verification

- Focused API/migration tests plus backend layering/module-size checks: passed.
- Ruff on the changed Python files: passed.
- Backend mypy: no issues in 391 source files.
- TypeScript compilation: passed.
- Frontend helper coverage: 97.18% lines, 93.33% branches, 100% functions using
  Node's `--experimental-test-coverage`.
- Production export: `npx next build --webpack` passed. The default Turbopack
  build stalled at compilation and was stopped.
- React suite: 759 tests passed across 128 files.
- Backend focused coverage: `github_import.py` 100%, measured task-store rules
  and writes plus import module 82% combined (302 statements, 53 missed), using
  a temporary `uv run --with coverage` environment.
- Full compiled Node suite: 2,886 passed, 3 failed. The two daemon timing
  failures (`stops the app-server promptly` and `update pause accounts for an
  in-flight poll`) both passed on isolated retry. The remaining failure is
  the existing `settings-page.css` font-weight 600 violating the weight ladder.
- Browser suite against the production export: 106 passed, 2 failed. The agent
  roster filter test cannot find its Add filter button; the team-edit test
  receives an additional `role: implementer` field. Those surfaces were not
  changed by these fixes. Local server startup required a sandbox permission
  retry after `listen EPERM`.

## Limits

The focused database tests use SQLite. PostgreSQL advisory locking and recovery
after an actual interrupted concurrent index build were not exercised against a
PostgreSQL server. The migration test starts from the persisted state such a
failure leaves behind. Python coverage tooling was installed temporarily after
an approved retry for sandbox DNS restrictions.

## GitHub App connection follow-up

The user requested a browser connection in place of token entry and selected a
GitHub App with read-only issue access to selected repositories. The setup guide
is [github-connection.md](../github-connection.md).

The connection lives on the Account, with encrypted access/refresh credentials,
single-use state bound to the login session, PKCE, per-account setup rate limiting,
and installation validation using the user token. Callback failures return to a
recoverable UI; a disconnect removes credentials and pending authorizations.
Connection cache keys include the Account id. The import drawer and Account
settings share the controls, with English and Simplified Chinese copy.

- Backend RED: the initial six connection API cases failed before implementation;
  the provider-error recovery and rate-limit cases also failed before their fixes.
- Browser RED found that URL canonicalization discarded the GitHub return flags.
  A route regression reproduced the loss before the canonicalization fix.
- Backend checks cover state replay, expiry, login-session mismatch, reconnect,
  encrypted storage, credential refresh, disconnect, selected-installation identity,
  excessive permissions, migrations, account-deletion cascades, and configuration.
- Final focused backend run: 50 passed. Connection-module coverage: 89% combined
  (237 statements, 25 missed), with the credential store at 100%.
- Route and GitHub helper Node suites: 49 passed.
- React suite including connection controls: 761 passed across 129 files.
- New production-export browser checks: desktop/light and mobile/dark both passed.
  They verify return-to-import, account status, absence of token inputs, pagination,
  capped select-all/clear behavior, and horizontal fit. Both renders were inspected.
- Production build (`npx next build --webpack`), backend mypy, Ruff, layering,
  module-size, anonymous/admin route sweeps, and `git diff --check`: passed.

GitHub responses are mocked in these tests; no real App was registered or authorized.
Deployment activation requires the administrator's App credentials and migration
0108. The full Python-suite attempt was interrupted by the user's follow-up;
the focused checks above were completed for the final scope. The earlier unrelated
Node/browser failures remain outside this change.
