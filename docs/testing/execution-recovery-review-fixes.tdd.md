# Execution recovery review fixes

The review supplied two journeys: an operator must be able to save a late
terminal report without reconciliation discarding it, and legacy stop/deletion
timestamps must not make execution status throw.

## RED / GREEN

Command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_execution_escape.py backend/tests/api/test_execution_reconcile.py -q
```

Before the fix: 5 failed, 20 passed. Two failures reproduced timezone-naive
timestamp subtraction; three reproduced retained evidence still offering
report-gone. After the fix and adding pending-deletion coverage: 26 passed.

The API fixture now supplies an assignment ID so normal successful finalization
can complete; the earlier fixture only exercised cancellation.

| Guarantee | Test | Result |
| --- | --- | --- |
| Timezone-naive and malformed stop/deletion marks enter recovery without throwing | `test_invalid_stop_intent_timestamps_enter_recovery` (unit) | PASS |
| Reports retained on either the request or command override stale missing-evidence flags | `test_restored_evidence_overrides_a_stale_missing_evidence_flag` (unit) | PASS |
| A late result rejects reconciliation, supports retry-save, and retains its successful outcome and log | `test_late_terminal_evidence_is_protected_and_can_be_saved` (API) | PASS |
| Pending deletion waits for saving the retained result and then finishes without an assertion | Same API test, `request_deletion=True` | PASS |

An expanded run including `backend/tests/unit/test_execution_lifecycle.py`
passed all 39 tests. A Python standard-library line tracer (`sys.settrace`, with
executable lines from `dis.findlinestarts`) measured the changed functions:
`execution_status` 48/49 lines (98%); `_stop_grace_elapsed` 10/11 lines (91%).
This is scoped line coverage, not repository-wide or branch coverage.

The production build and TypeScript compilation passed. `npm test` stopped on
failures outside the modified execution code; the model-list, design-grid, and
project-page test files reproduced four failures when run separately.

Final affected-area check:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_execution_reconcile.py backend/tests/api/test_session_delete.py backend/tests/unit/test_execution_escape.py backend/tests/unit/test_execution_lifecycle.py backend/tests/unit/test_execution_blocker_regressions.py backend/tests/unit/test_execution_attention.py -q
```

Result: 69 passed. `git diff --check` also passed.

The separate React run reported 430 passed and one unrelated timeout in
`rosterTabs.test.tsx`. The separate full backend run was interrupted after
reporting 207 passed and two installer failures: controlling-terminal tests
could not access `/dev/tty` under the sandbox. This does not establish a passing
full backend suite.

The working tree already contained the reviewed changes. No separate RED/GREEN
checkpoint commits were created; this report preserves the evidence for the PR.
