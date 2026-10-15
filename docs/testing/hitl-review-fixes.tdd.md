# HITL review fixes: test evidence

The three journeys came from the review of the uncommitted HITL changes:
reject a finished turn without racing admission, retain a question without
triggering task-failure automations, and attribute Stop to its initiating person.

| Guarantee | Regression test |
| --- | --- |
| Reject validation holds admission exclusion | `test_reject_serializes_validation_with_run_admission` |
| Reject reads the thread again after acquiring locks | `test_reject_rechecks_the_thread_after_acquiring_admission_scope` |
| A question with a nonzero exit emits no blocked task transition | `test_a_question_survives_the_cli_exiting_badly_after_asking` |
| Stop retains its first actor across restart and late completion | `test_stop_keeps_its_actor_across_registry_restart` (file and database stores) |
| Admin identity reaches cancellation without losing admin access | `test_admin_stop_preserves_identity_for_backend` |
| Delivered Stop records the UI user or admin | `test_cancel_command_is_redelivered_until_run_termination_confirms_it` |

RED: the initial five cases failed for the intended bugs. GREEN: the same
five cases passed after the fixes. Command:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_backend_review_regressions.py backend/tests/unit/test_daemon_registry.py -q -k 'serializes_validation or admin_stop or stop_keeps or survives_the_cli'
```

The affected API, registry, and execution lifecycle suites passed 439 tests.
The expanded Stop cases passed six tests; the final review regression API file
passed 31 tests. Numeric coverage was not measured: the backend environment
does not include a coverage runner. Live PostgreSQL concurrency remains an
environment-dependent check; SQLite and file-store paths were exercised.

Broader verification: the full backend run passed 2,672 tests, skipped 18,
and failed only the two unchanged installer tests denied `/dev/tty` access.
The expanded cases added during that run were covered by the separate final
API and Stop runs above. TypeScript compilation passed; Node tests passed
2,129 with three unchanged process/port permission failures and one skip.
React tests passed 467 with the same unchanged roster timeout seen in review.
`npm test` could not proceed past Next.js's local-port sandbox restriction.
`git diff --check` passed.
