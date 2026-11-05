# Node 22 CI test harness evidence

Source: PR #658's TypeScript and web job, run `41950644074` on Linux with
Node 22.23.4. Its Node runner reported 2,904 passing tests, two failures, and
18 cancellations. No tests are skipped or removed by this fix.

## RED

The job log identifies three fixture problems:

1. Mocked readiness/model checks and fetches return pending promises without an
   underlying process/socket handle. `AbortSignal.timeout` does not keep Node's
   event loop alive. Node 22 cancels these tests and subsequent tests when no
   referenced handles remain.
2. The update-pause test expects execution to have started as soon as admission
   is acknowledged. The handshake promises journaled admission; runtime
   preparation may still be pending, so the assertion races setup.
3. The broker-failure fixture sets a missing `TMPDIR` before workspace locking.
   The lock creates its temporary directories recursively and can create that
   supposedly missing parent, letting the permission broker start successfully.

On local Node 22.20.0, running the preflight/model/supervisor targets reproduced
17 cancellations. The focused daemon targets reproduced one pass and one failure
(`expected run.failed, saw run.completed`). The Linux CI log supplies the
update-pause race evidence (`0 !== 1`).

## Changes and guarantees

| Guarantee | Evidence |
| --- | --- |
| Mock transport deadlines actually fire on Node 22 | Each relevant test holds a referenced interval, cleaned with `t.after`; its original timeout/abort assertions are retained. |
| Pause acknowledgement covers admitted work before runtime startup finishes | A preparation barrier holds execution; the test checks one pending journal entry and no extra poll, then releases preparation and awaits the explicit execution-start signal. |
| A permission broker that cannot start never falls back to an unprompted agent run | The fixture changes `TMPDIR` during readiness, after workspace locking; it still asserts `run.failed`, the prompt error, no completion, and no Pi agent command. |

The deadline handles stand in for the resource missing from the test doubles;
production timeout behavior is unchanged. All edits are in test files.

A clean Linux reproduction also found fake Codex/Kimi servers exiting on stdin
EOF before their SIGTERM audit handler ran. The service stand-ins now hold a
referenced interval until they exit, so the existing shutdown assertions exercise
signal handling instead of racing EOF. This changes no production shutdown code.

## GREEN

```sh
node --test dist/packages/relay-daemon/tests/agent-preflight.test.js \
  dist/packages/relay-daemon/tests/agent-models.test.js \
  dist/packages/relay-daemon/tests/runtime-lifecycle.test.js \
  dist/packages/relay-supervisor/tests/supervisor.test.js
node --test --test-name-pattern='update pause|a native local run fails' \
  dist/packages/relay-daemon/tests/daemon.test.js
```

On Node 22.20.0 these pass 61 and two tests respectively, with zero cancellations.
The full `npm run test:ts` passes the production build, 2,920 Node tests, and
798 React tests with zero failures or cancellations. All 17 pre-commit hooks pass.

A separate clean Linux container uses Node 22.23.4, `CI=true`, `npm ci`, and the
same `npm run test:ts` command. Its final results and the follow-up GitHub run are
recorded in the PR. Browser behavior and Python runtime code are unchanged;
no new coverage gate is needed for these fixture-only changes.

The CI/local RED results above and this fix commit preserve the regression
evidence for a later squash merge.
