# Installer service shutdown review fixes

The journeys come from the installer review: reusing a computer in foreground mode
must not leave its background daemon running, and cleanup must keep the service
file when shutdown cannot be confirmed.

## RED and GREEN

Before changing production code, the compiled helper tests failed on six new
shutdown failure cases: cleanup returned without throwing and removed the service
files. The packaged installer foreground regression also failed because it
registered without any preceding service stop calls.

After the fix, the installer/installed-computer/control target passed all 23 tests.
An additional already-unloaded macOS case subsequently passed in the 13-test
helper target. Service definitions remain available after foreground startup or
failed shutdown. Failed disable commands, still-running services, and unavailable
status probes all prevent deletion. Foreground registration occurs only after
shutdown verification; a failed stop prevents registration.

Commands used:

```sh
npx tsc -p packages/tsconfig.json
npm run build -w relay-daemon
node --test dist/packages/relay-daemon/tests/install.test.js dist/packages/relay-daemon/tests/installed-computers.test.js dist/packages/relay-daemon/tests/control.test.js
node --experimental-test-coverage --test-coverage-include='**/installed-computers.js' --test dist/packages/relay-daemon/tests/installed-computers.test.js
```

The helper coverage run reported 94.74% lines, 88.89% branches, and 100% functions.
This is coverage of the installed-computer helper, not the entire daemon package.
Service commands use fixtures for both platforms; no installed user services were
changed. A read-only `launchctl print` probe confirmed exit status 113 for an
absent service on this Mac. Linux behavior is fixture-tested, not tested against
a running Linux systemd user session.

The pre-existing uncommitted installer changes were preserved; no checkpoint
commits were created. This report records the RED/GREEN evidence directly.

## Broader verification

- `npm test`: production build passed; compiled TypeScript suites passed 2,024
  of 2,026 tests, including all 24 installer/helper/control tests. Two unchanged
  web tests failed: `designGrid.test.ts` rejects a 720px breakpoint in
  `project-page.css`, and `projectPage.test.ts` expects a different tab order.
  The failing tests and their source files match `HEAD`.
- `npm run test:react -w web`: 431 tests passed across 67 files.
- `git diff --check`: passed.
- `npm run test:py`: 2,320 tests passed; one unchanged schema-drift test
  failed (`test_schema_review_backfills_derived_columns_and_projections`). Its
  PostgreSQL constraint lookup returned multiple rows. No backend files changed.
