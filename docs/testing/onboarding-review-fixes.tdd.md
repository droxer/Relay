# Onboarding review fixes

Journeys come from the five review findings against
[the onboarding design](../onboarding-wizard-design.md): preserve rapid choices,
merge concurrent preference intents, run the starter on the ready Computer with
its Agent, explicitly reopen an existing account, and count only completed
Agent runs.

## Red and green evidence

Before the fixes, the new hook tests failed on concurrent requests, an earlier
failure clearing a later optimistic dismissal, and reopening without recording
the intro choice. The progress tests failed for a manually completed Thread
with only failed runs and for a ready Agent on the second Computer. The panel
test failed because the starter callback received text without its target.
The backend concurrency test failed for both stores: the file store raced on
its temporary file and SQLite lost one of the two accepted choices.

| Guarantee | Regression coverage | Result |
| --- | --- | --- |
| Rapid card closes save in order and retain pending choices | `web/interaction-tests/useOnboarding.test.tsx` | PASS |
| A failed save does not block later saves or clear their optimistic state | `web/interaction-tests/useOnboarding.test.tsx` | PASS |
| Existing file-store accounts can explicitly reopen the wizard | `web/interaction-tests/useOnboarding.test.tsx` | PASS |
| Concurrent intents preserve both choices across store instances | `backend/tests/unit/test_onboarding_preferences.py` | PASS (file and SQLite) |
| The starter carries a matching Computer and Agent | `web/tests/onboarding.test.ts`, `web/interaction-tests/onboardingPanel.test.tsx` | PASS |
| Placements use their current runtime node and must be active with a ready runtime | `web/tests/onboarding.test.ts` | PASS |
| Marking a Thread done does not fabricate a completed Agent run | `web/tests/onboarding.test.ts` | PASS |

Browser saves are queued and only the last pending save clears optimistic
state. Database preference updates acquire their write lock before reading the
onboarding JSON; invalid patches roll the transaction back. The file store
uses its shared auth lock. The starter callback selects the derived runtime
node and Logical Agent in the composer before inserting the prompt.

## Validation before rebasing onto current main

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_onboarding_preferences.py backend/tests/unit/test_account_onboarding_migration.py backend/tests/api/test_auth.py -q`: 56 passed.
- `npx tsc -p packages/tsconfig.json` and `node --test dist/web/tests/onboarding.test.js`: passed, 15 progress tests.
- `npm run test:react -w web -- interaction-tests/onboardingPanel.test.tsx interaction-tests/useOnboarding.test.tsx`: 12 passed.
- From `web/`, `npx vitest run interaction-tests/useOnboarding.test.tsx --coverage --coverage.include=src/hooks/useOnboarding.ts --coverage.reportsDirectory=/tmp/relay-onboarding-coverage`: 100% statements, functions, and lines; 81.25% branches.

- `npm exec -w web -- next build --webpack`: production build and web TypeScript check passed. Turbopack could not bind its helper port in this environment, including the permission retry.
- Compiled package/web tests: 2,295 passed, 1 skipped, 5 failed in unrelated installer/process harnesses (`listen EPERM`, `spawn EPERM`, and a signal harness unable to start).
- `npm run test:react -w web -- --maxWorkers=2`: all 543 tests in 92 files passed.
- Focused ESLint check for the five changed frontend implementation files passed.
- `npm run test:py`: 2,832 passed, 22 skipped, 2 failed (the installer TTY tests below).
- The two backend installer TTY failures were reproduced separately: `/dev/tty: Operation not permitted`.

## Limits

Concurrency was exercised with the file store and SQLite. Local PostgreSQL was
unavailable; its account update uses the same write-before-read transaction,
which takes a row lock on PostgreSQL. No live daemon onboarding E2E was run.
The fixes and regression tests are included in the onboarding feature change.

## Integration with current main

Rebased onto main's password-reset flow and existing dependency security patch.
Onboarding migration is now `20261016_0098`, following password resets
(`20261016_0097`); `alembic -c backend/alembic.ini heads` reports one head.

- Re-ran the onboarding preference/migration tests, auth API tests, and password-reset API tests: 68 passed.
- Package TypeScript compilation and all 15 onboarding progress tests passed.
- Production Webpack build, including the web TypeScript check, passed.
- Synced main's dependency override with `npm install --ignore-scripts --registry=https://registry.npmjs.org`; no tracked dependency files changed. The fresh npm audit reports zero vulnerabilities.
- Full post-rebase React suite: all 547 tests in 93 files passed with `npm run test:react -w web -- --maxWorkers=2`.
