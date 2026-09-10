# Runtime stability fixes

Source: continuation of an in-progress runtime review. The worktree already
contained the regression tests; no separate plan file was supplied.

## User journeys

| User journey | Guarantee |
| --- | --- |
| Provision a managed Computer through a transient backend failure | A provider instance is linked on a later reconcile pass without duplicate allocation or false attempt failure. |
| Stop a Computer after its instance-link PATCH failed | The supervisor retains the allocated handle and stops the provider instance before marking the Computer stopped. |
| Dispatch work while terminal events are finalizing | Admission and activation follow global-to-node lock order and do not deadlock or expose a half-activated request to the reaper. |
| Run multiple backend replicas | Durable capability and retirement changes refresh even when a replica has a newer in-memory heartbeat. |
| Retire or delete a daemon node | Stale registrations and heartbeats cannot erase the durable retirement fence in either store implementation. |

## RED evidence

- `npx tsc -p packages/tsconfig.json && node --test --test-name-pattern='instance linkage|linkage PATCH' dist/packages/relay-supervisor/tests/managed-reconcile.test.js`: **3 failed**. Both ambiguous PATCH cases marked the attempt failed, and drain did not stop the unlinked instance.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_runtime_stability.py -q`: **10 failed**. Three lock-order cases inverted node/global acquisition, capability refresh stayed stale, and retirement could be erased by stale writes.

## GREEN evidence

| Guarantee | Test target | Type | Result |
| --- | --- | --- | --- |
| Ambiguous provider linkage retries without reallocating | `managed reconciler retries instance linkage after PATCH failure` | unit | PASS, both committed and uncommitted response-failure variants |
| Drain cleans up an allocated but unlinked provider instance | `managed reconciler stops an allocated instance whose linkage PATCH failed` | unit | PASS |
| New and continuing run admission use safe lock order | `test_run_admission_obeys_terminal_event_lock_order` | integration | PASS, both new and existing Thread variants |
| Direct activation validates before exposing running state | `test_direct_activation_obeys_terminal_event_lock_order` | integration | PASS |
| Replica refresh separates durable metadata from heartbeat freshness | `test_replica_refreshes_capabilities_without_a_newer_heartbeat` | integration | PASS |
| Retirement is monotonic across replicas and stores | `test_stale_replica_registration_preserves_retirement`, `test_store_rejects_stale_registration_and_heartbeat_resurrection` | integration | PASS for file and SQLite stores, stopped and deleted states |

Focused final results:

- Runtime stability suite: **10 passed**.
- Supervisor suite: **49 passed**.
- Backend daemon registry/API slice: **288 passed**.
- Regression compatibility slice: **13 passed**.
- Full backend suite: **1,167 passed, 3 skipped**; the skips require PostgreSQL.
- `npm test` completed the TypeScript build, production web build, Node tests,
  and React tests successfully before the initial full Python backend run found one
  compatibility regression. That regression was fixed and the full backend
  suite was rerun successfully.
- `git diff --check`: passed.

## Coverage and known gaps

`node --experimental-test-coverage --test
dist/packages/relay-supervisor/tests/*.test.js` passed all 49 tests and reported
**97.83% line coverage, 83.33% branch coverage, and 93.33% function coverage**
for `managed-reconcile.js`.

The installed backend development environment does not include `pytest-cov`,
so a separate Python coverage percentage was not collected. The complete
1,170-test backend suite was executed instead. No live cloud provider or
multi-process deployed backend was used; concurrency behavior is covered with
deterministic lock-order and multi-store replica harnesses.
