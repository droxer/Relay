# Public-only GitHub imports

## Scope

The user limited issue imports to public repositories and deferred GitHub
connection with a Coming soon label. This supersedes the connection activation
instructions added in PR #630; its database migrations remain unchanged.

## Guarantees

- Preview and import validate `private: false` and `visibility: public` using
  GitHub's [repository metadata](https://docs.github.com/en/rest/repos/repos#get-a-repository).
  Private, internal, and missing visibility fail closed before issue reads.
- The issue client cannot accept a token. API token fields are rejected; saved
  Account credentials are never read by imports. Every GitHub request is anonymous.
- Connect and callback return 501 after checking the Relay login session. Status
  reports Coming soon even with App settings present, which startup now ignores.
- Settings and the import drawer show a static Coming soon badge and public-only
  copy, without connection controls or status requests. Existing credential cleanup
  is still available through the authenticated disconnect endpoint.

## RED and GREEN

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_github_connection.py backend/tests/api/test_github_issue_import.py -q
cd web && npx vitest run interaction-tests/githubConnection.test.tsx
```

RED: 9 backend failures demonstrated enabled authorization, token authentication,
accepted private/internal repositories, and saved-credential access. The React
case failed because it expected a static Coming soon panel without API reads.
GREEN: all focused cases passed after enforcement and UI updates.

## Verification

- Backend API plus anonymous/admin route sweeps, layering, and module-size checks:
  passed. Existing repeated, deleted, cross-destination, and concurrent imports pass.
- Measured changed API/issue-client coverage: 87% across 218 statements.
- Route/import-helper Node suites: 49 passed; TypeScript compilation passed.
- React suite: 759 passed and one unrelated roster keyboard test timed out.
  Isolated retry of the roster and GitHub panel files: all 5 passed.
- Desktop/light and mobile/dark browser checks: both passed, including the static
  badge in Settings and import, no connection requests, and capped selection/clear.
  Both screenshots were inspected.
- Production export (`next build --webpack`), mypy, Ruff, CSS lint, and
  `git diff --check`: passed. The Impeccable detector reported no findings.
- Dependency manifests/lockfiles are unchanged. npm audit reports the existing
  33 advisories (7 high); pip-audit reports 32 findings across 4 packages in the
  audited development/tool environment.

GitHub responses are mocked. No live private repository or App authorization
was accessed, and no existing credentials were deleted by verification outside
the isolated test databases. No schema upgrade or new deployment settings are
needed for this follow-up.
