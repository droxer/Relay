# Handoff recovery regression evidence

The user requested fixes for four review findings. Tests exercise the existing
daemon event/recovery path, task stores, and handoff cue derivation.

| Guarantee | Regression coverage |
| --- | --- |
| A thread completion followed by a failed task write is repaired by recovery | `test_recovery_repairs_a_partially_written_completion`, file and SQLite daemon stores; also preserves newer human acceptance |
| A staged or linked-but-unpublished successor has a bounded retry budget | `test_staged_successor_recovery_has_a_failure_limit`, both stores and both failure locations |
| Delivery winning a failure race retains its reservation | `test_delivery_winning_a_failure_race_retains_the_execution`, both stores |
| Retrying an unfinished round does not spend its budget twice | `test_recovery_counts_an_unfinished_round_only_once`, both daemon stores |
| Round deduplication survives restart and concurrent retries while allowing a new execution owner | `test_round_recording_is_idempotent_for_each_execution_owner`, file and SQLite task stores |
| An unaddressed consultation answer resumes its asker in the UI | `teamHandoff.test.ts`, “resumes the asker when the consultation answer has no explicit recipient” |

Before the fixes, all eight initial backend regression cases failed, and the
UI regression produced `closing` instead of `handoff`. After the fixes:

```text
backend/.venv/bin/python -m pytest backend/tests/unit/test_daemon_registry.py backend/tests/unit/test_task_store.py backend/tests/unit/test_task_execution_ownership.py -q
409 passed

npx tsc -p packages/tsconfig.json
node --test dist/web/tests/teamHandoff.test.js dist/web/tests/handoffStatus.test.js dist/web/tests/sessionPollMerge.test.js
44 passed
```

The existing human continuation-budget test now executes distinct rounds rather
than counting repeated finalization of one execution as separate rounds. No
coverage percentage is claimed; these tests target the observed failure paths.

Broader validation:

- `npm run build -w web -- --webpack`: production build, typecheck, and static export passed.
- `npm run lint -w web`: passed.
- `npm run test:react -w web -- --maxWorkers=2`: 530 passed; reducing concurrency resolved two timeouts in the first run.
- Full compiled Node suite: 2,245 passed, 5 failed, 1 skipped. The failures require local socket binding or process spawning denied by this environment (`EPERM`).
- `backend/.venv/bin/python -m pytest backend/tests -q`: 2,808 passed, 2 failed, 22 skipped. Both failures are installer controlling-terminal tests denied access to `/dev/tty`. The four final human-acceptance/delivery-race cases were added after this run collected its tests and passed in the focused suite above.
- The normal Turbopack build could not bind its worker port, including on an elevated retry; the webpack build passed without configuration changes.
- `git diff --check`: passed.
