# Relay client version: TDD evidence

Journeys were derived from the requested client daemon version support.

| Guarantee | Evidence | Result |
| --- | --- | --- |
| Client and daemon CLI report their installed package release without backend access | `packages/relay-daemon/tests/client-version.test.ts`, `cli.test.ts`, `control.test.ts` | PASS |
| An installed package with a different release reports its own version | Isolated package test using `7.8.9-rc.1+test` | PASS |
| Every daemon registration sends the package release | `daemon.test.ts`: advertises only agents with passing capability preflight | PASS |
| Registration validates SemVer, stores/reports versions, and clears identity on legacy re-registration | `backend/tests/api/test_daemon_client_version.py` | 10 passed |
| Adding/removing the nullable version column preserves existing nodes | `backend/tests/unit/test_daemon_client_version_migration.py` | 1 passed |
| Packaged CLI and capability manifest agree with package metadata | Built bundle extracted to a temporary directory; ran its `dist/cli.js --version` | PASS (`relay-daemon 0.1.0`) |

## RED / GREEN

- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_daemon_client_version.py -q`:
  RED: 9 failed (version discarded; schema accepted invalid versions).
  GREEN: 9 passed, then 10 passed after adding the HTTP regression test.
- `npx tsc -p packages/tsconfig.json`: compile-time RED on missing
  `../src/client-version.js`; GREEN after implementation.
- `node --test --test-name-pattern='relay client version' dist/packages/relay-daemon/tests/control.test.js`:
  RED: 3 failed (unknown commands). GREEN: all three pass.
- `node --test dist/packages/relay-daemon/tests/control.test.js`: 14 passed.
- `node --test dist/packages/relay-daemon/tests/client-version.test.js dist/packages/relay-daemon/tests/cli.test.js`
  with `--experimental-test-coverage --test-coverage-include='**/src/client-version.js'`:
  8 passed; version module 100% lines, branches, and functions.
- Refined the daemon registration assertion to compare the exact package version
  without a type cast; its focused daemon test passed.

Checkpoints on the task branch:
`00bed375` (release-reporting RED), `206e1fd1` (GREEN),
`e8bbb890` (control command RED), `a4af5f68` (GREEN).
The RED checkpoint intentionally skipped the package typecheck hook because
its missing-module error was the recorded RED signal; GREEN hooks all passed.

## Broader verification

- `npm run build`: PASS (packages, installer bundle, production web export, test compilation).
- Canonical `node --test` across relay-core, relay-daemon, relay-supervisor, and web: 2,971 passed.
- `npm run test:react -w web`: 836 passed in 142 files.
- Focused backend installer, host OS, capability parity, layering, and module size run: 53 passed.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_automation_discovery_migration.py backend/tests/unit/test_schema_drift.py -q`:
  19 passed against a disposable local PostgreSQL schema, including full migration
  metadata parity. The initial rollback test failed because it hardcoded revision
  `0119` as head. It now captures the revision before the rejected downgrade and
  asserts that it remains unchanged; the rerun passes.
- `npm run test:py`: 3,800 passed, 28 skipped, one stale migration-head
  assertion failed (the test module had been collected before the fix).
  The corrected PostgreSQL migration/schema suite passed all 19 tests.
  `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest --lf -q`
  reran the full run's sole failure: 1 passed. All collected non-skipped backend
  tests therefore have a passing result (3,801 total across the run and rerun).
- `ruff check` on changed Python files: PASS.
- `cd backend && uv run mypy`: PASS, 449 source files.
- `npm audit --omit=dev --audit-level=high --registry=https://registry.npmjs.org`: zero vulnerabilities.

The initial `npm test` wrapper aborted in its nested npm build process (exit 134).
The standalone build and test suites above succeeded. The configured npm mirror
has no audit endpoint; audit used the public npm registry without changing config.

## Scope and limits

The existing package release remains `0.1.0`; future releases change package
metadata. Capability-based compatibility and Outdated Client policy are
unchanged. No frontend rendering changed, so browser E2E was not required.
The database migration was exercised on SQLite and through the full PostgreSQL
migration chain and schema-drift checks. Python coverage was not measured.
