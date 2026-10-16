# Password reset review fixes

Source: the review of the uncommitted implementation described in
[password-reset-design.md](../password-reset-design.md).

| User guarantee | Regression | Red evidence | Green evidence |
| --- | --- | --- | --- |
| A concurrent file-auth writer cannot restore the old password or revoked sessions. | `test_file_reset_survives_a_concurrent_auth_write` (preferences and session cases, separate store instances) | Both cases failed before shared locking was added to file-auth mutations. | Both pass after locking. |
| A reissue and redemption serialize on the Account before either claims a reset row, and redemption rechecks a retired link. | `test_database_redemption_rechecks_a_link_after_account_lock`; `test_password_reset_redemption_waits_for_account_before_claiming_link` | The unit test accepted a retired link; the PostgreSQL test raised `LockNotAvailable` with the original method substituted in memory. | Both pass with Account-first locking and a liveness recheck. |
| A transient lookup failure can be retried without reopening the original link or restoring the token to the URL. | `web/interaction-tests/passwordResetScreen.test.tsx` | Network, 500, and 429 cases failed because no retry button existed. | All four tests pass, including the separate 404 case without retry. |

Validation:

- Full backend suite outside the sandbox: `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-xdist pytest backend/tests -q -n 4 --dist loadfile --tb=short`: 2908 passed, 1 skipped in 169.09 seconds.

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_password_reset_service.py backend/tests/api/test_password_reset_routes.py -q`: 71 passed.
- The PostgreSQL schema suite and the two terminal-dependent installer tests run outside the sandbox: 19 passed.
- `npm run test:react -w web`: 535 passed.
- `npx tsc -p packages/tsconfig.json` and the five built password-reset utility tests: passed.
- `npm run build -w web`: passed.
- `git diff --check`: passed.

The PostgreSQL test uses a scratch schema migrated to head and drops it afterward.
No new coverage percentage was collected. Changes remain uncommitted alongside
the existing feature work; this report preserves the red/green evidence.
