# Private GitHub issue import verification

Journeys were derived from the request: select an existing GitHub Connection,
preview private issues, and import selected issues into a Project or intake.
Public imports remain available anonymously.

## Evidence

- RED: the initial new API tests reported **21 failed**. Private preview returned
  `github_public_repositories_only`; invalid or unavailable connection IDs were
  ignored and allowed anonymous reads.
- RED: the initial drawer tests reported **3 failed**: no account selector or
  connection-aware request existed.
- GREEN: backend API and architecture checks reported **78 passed**:
  `PYTHONPATH=backend /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m pytest backend/tests/api/test_github_private_import.py backend/tests/api/test_github_issue_import.py backend/tests/api/test_connections.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q --tb=short`.
- GREEN: focused UI tests reported **25 passed** across GitHub import,
  GitHub connection, Connection Grants, and Project workspace interaction tests.
  Run from the repository with Vitest using `web/vitest.config.ts`, `--root web`,
  and `--configLoader runner`. This session used the existing main checkout's
  dependency installation through a temporary ignored `node_modules` symlink.
- Backend mypy reported **Success: no issues found in 462 source files**.
- Before PR creation, installed the locked frontend and backend development
  dependencies and built `relay-core`. Web typechecking then passed with
  `node_modules/.bin/tsc -p web/tsconfig.json --noEmit`.
- `npm audit --package-lock-only --audit-level=high` against the npm registry
  reported **0 vulnerabilities**. Python audit could not run because
  `pip_audit` is not installed.
- Ruff on the changed Python files, ESLint on the changed UI implementation,
  the Impeccable detector, and `git diff --check` passed.

| Guarantee | Evidence |
| --- | --- |
| Private preview and import authenticate using only the selected account | `backend/tests/api/test_github_private_import.py` |
| Another owner, missing Connection, wrong provider, insufficient action, disconnected or reconnect-required Connection is rejected before GitHub reads | Same API tests, parametrized over both routes |
| Malformed connection IDs never fall back to anonymous reads | Same API tests |
| A chat-service actor cannot borrow a User's Connection, including with an unrelated admin cookie | Same API tests |
| Expired tokens refresh before import; Tasks receive no implicit Connection Grants | Same API tests |
| GitHub denial stops reads, 401 does not sign the User out, and redirects cannot leak tokens to another host | Same API tests |
| Anonymous imports do not implicitly use saved Connections | Both GitHub import API test files |
| Preview and import send the same Connection; changing accounts disables the old selection | `web/interaction-tests/githubImport.test.tsx` |
| Reconnect-required accounts are disabled; access errors have actionable copy | Same UI tests |
| Existing import deduplication, public visibility rules, and architecture invariants remain valid | Existing import API tests and layering/module-size checks |

## Limits

GitHub requests were mocked; no real private repository was read. No schema
change, deployment, or remote write was performed. The first web typecheck was blocked by missing dependencies in the shared
installation; this was resolved before PR creation by installing the locked
workspace dependencies and building `relay-core`. The full web build and live
browser visual verification were not completed.
Coverage was not measured because `pytest-cov` is unavailable; no percentage is
claimed. Full repository suites were not run. TDD stage evidence is recorded
here; no Git checkpoint commits were created.
