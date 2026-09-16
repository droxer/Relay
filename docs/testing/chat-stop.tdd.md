# Chat Stop during dispatch

Journeys were derived from the reported chat composer Stop failure.

A send immediately displays Stop, before the backend response supplies the new
thread ID or updates an existing thread's running state. The old handler returned
without retaining the click. The hook now retains that intent across renders and
cancels the accepted thread after dispatch resolves.

## Evidence

- RED: `npm run test:react -w web -- interaction-tests/threadStop.test.tsx`
  executed two new/continued-thread cases. Both failed: cancellation calls = 0.
  Checkpoint: `f236fe72`.
- GREEN: the same command passed both cases after the fix. Additional cases cover
  duplicate clicks, ordinary sends, dispatch rejection, immediate cancellation,
  and stopping another thread while a send is pending. Final result: 6 passed.
  Initial fix checkpoint: `70462f25`.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- Focused backend cancellation tests: 29 passed (`pytest` on
  `backend/tests/api/test_daemon_api.py` and
  `backend/tests/unit/test_daemon_registry.py`, with `-k cancel -q`).
- `npm audit --registry=https://registry.npmjs.org --audit-level=high`:
  0 vulnerabilities. The configured mirror does not implement the audit endpoint.
- `git diff --check`: passed.

## Guarantees

| Behavior | Test | Result |
| --- | --- | --- |
| A pending new or continued send retains Stop across a render | threadStop.test.tsx parameterized cases | PASS |
| Repeated pending Stop clicks issue one cancellation | Same cases | PASS |
| An ordinary send does not cancel | Ordinary-send case | PASS |
| A failed dispatch does not leak Stop into the next send | Failure/retry case | PASS |
| An already running thread cancels immediately | Running-thread case | PASS |
| Stop in another thread does not cancel the pending send | Thread-switch case | PASS |

## Boundaries

Cancellation still uses the existing API and daemon command path. No process is
executed or killed by the backend. There are no schema or protocol changes.
Cancellation failures continue to use the mutation's existing error toast.

These interaction tests exercise the real hook with controlled mutation promises;
they do not prove termination of a live agent process. The reported live runtime
and agent were not supplied. This fix covers the reproduced dispatch timing race.

The full React coverage run had 72 passing tests and one timeout in the existing
rosterTabs keyboard-navigation test. That file passed all 4 tests when rerun alone.
No coverage percentage is claimed for the changed hook; the repository coverage
configuration targets other modules.
