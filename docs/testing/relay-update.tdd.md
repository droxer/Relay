# Relay update regression evidence

Journeys derived from the review: updating an installed computer preserves its
saved agent settings, and an update without `--force` cannot interrupt a run
admitted while the installer is downloading.

## Red / green

- Added tests for preserving the complete runtime profile and for the daemon
  admission handshake before implementing the fixes.
- RED: `npx tsc -p packages/tsconfig.json` failed with TS2307 for the new
  `update-pause` handshake module referenced by the regression test.
- GREEN: TypeScript compilation and all 10 updater tests pass. The daemon
  integration test also verifies an in-flight poll is accounted for before
  acknowledgement, polling remains paused, and release resumes polling.
- RED/GREEN evidence is retained here alongside the regression tests in the
  feature commit.

| Guarantee | Evidence |
| --- | --- |
| Preserve saved settings when the updating shell differs | `install.test.ts`: upgrade from a shell without `CODEX_HOME` preserves the profile byte for byte |
| Missing or malformed profiles abort visibly | `update.test.ts`: complete saved runtime profile test |
| Late admissions block an unforced update | `daemon.test.ts`: in-flight poll test; `update.test.ts`: late-run recheck test |
| Pause spans installer execution and releases on errors | `update.test.ts`: failed installer, launch exception, and missing acknowledgement |
| Competing updaters cannot release another pause | `update.test.ts`: concurrent updater test |
| An exited updater does not permanently pause admission | `update.test.ts`: abandoned request test using a real exited process |

## Verification

```sh
npm run build -w relay-daemon
npx tsc -p packages/tsconfig.json
node --test dist/packages/relay-daemon/tests/*.test.js
node --experimental-test-coverage --test-coverage-include='**/src/update.js' --test-coverage-include='**/src/update-pause.js' --test dist/packages/relay-daemon/tests/update.test.js
git diff --check
```

The final daemon regression run passed 372 tests. Final updater coverage is
94.69% lines, 88.10% branches, and 100% functions across `update.ts` and
`update-pause.ts`; all 10 focused tests pass.

The repository-wide build and Node suite passed 2,133 tests; the React suite
passed all 469 tests in 70 files. `npm test` completed successfully, including
the Python suite: 2,725 passed and one skipped. The final computer installer
bundle was also rebuilt with `npm run build:computer`.

Tests use fake backend responses, local mock HTTP servers, and temporary service
definitions. No real installed computer was restarted. Windows command quoting
is tested; a live Windows Task Scheduler upgrade remains untested.
