# Asynchronous cancellation report evidence

Date: 2026-11-11. Source: the reported local Computer dispatch stall and the
request to send cancellation reports asynchronously; no separate plan file.

## Behavior

As a Computer owner, I need command polling to continue when delivery of a
cancellation report stalls or fails. The daemon now tracks one background
report sender per command and target lease, keeps the existing durable outbox
and retry policy, and aborts and settles pending senders during shutdown.

This fixes the polling stall caused by awaiting delivery. It does not identify
or fix the underlying network failure reported as `fetch failed`.

## TDD evidence

RED checkpoint: `0235821e` on `mc/fix-local-computer-dispatch`.

After `./node_modules/.bin/tsc -p packages/tsconfig.json`, this command executed
both new tests and failed with `1 !== 3` command polls:

```sh
node --test --test-name-pattern='keeps polling while a cancellation report' dist/packages/relay-daemon/tests/daemon.test.js
```

After the fix, the same cases and the existing successful-delivery test passed
(3 tests):

```sh
node --test --test-name-pattern='keeps polling while a cancellation report|reports a cancel for a run it never received' dist/packages/relay-daemon/tests/daemon.test.js
```

| Guarantee | Regression case | Result |
| --- | --- | --- |
| A hanging report request does not block subsequent command polls | `keeps polling while a cancellation report is stalled` | PASS |
| A 503 and retry backoff do not block subsequent command polls | `keeps polling while a cancellation report is unavailable` | PASS |
| Redelivered cancellations share one pending sender | Both new cases | PASS |
| Shutdown leaves the report and original target lease in the durable outbox | Both new cases | PASS |
| Successful cancellation delivery still reports the correct outcome | Existing `reports a cancel for a run it never received as cancelled` | PASS |

TypeScript package compilation, the daemon package build, and `git diff --check`
passed. The shared-core suite passed all 254 tests. The scoped npm dependency
audit against the official registry reported zero vulnerabilities; the
configured registry mirror does not implement the audit endpoint.

The broader daemon suite requires localhost and process-inspection permissions.
`node --test --experimental-test-coverage dist/packages/relay-daemon/tests/*.test.js`
completed with 749 passing tests and one missing-fixture failure. Its
installer-bundle case initially lacked `backend/relay/computer/daemon.tar.gz`;
after `node tools/build-computer.mjs`, its separate rerun passed. No installed
Computer or external backend was changed during this implementation.

Coverage of the tested daemon `index.js` was 89.62% lines, 80.72% branches,
and 87.27% functions. Aggregate coverage of all imported files was 63.35% lines;
this run does not establish 80% coverage of the entire repository. Python and
web suites were not run because their code and contracts are unchanged.

The GREEN checkpoint includes the implementation and this report. If commits
are squashed, retain the RED failure and GREEN guarantees above in the PR body.
