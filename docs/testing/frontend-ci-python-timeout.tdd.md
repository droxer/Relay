# PR #729 Python CI timeout

CI failed only `test_dispatch_claim_prevents_reaper_from_creating_second_command` with `TimeoutError` at `run_future.result(timeout=1)`. The test's correctness depends on event ordering, not finishing database writes within one second.

The focused test passed normally. A temporary pytest fixture delayed `_run_sync`'s return by 1.1 seconds after dispatch; the original test then failed with the same timeout. With the fix, the delayed-worker test passed. The fixture is outside the repository and is not shipped.

Use a ten-second bounded wait for the claim/release events and worker completion. Always release the paused worker in `finally`. Preserve all assertions that the reaper cannot publish a second command and that exactly one command is delivered. No production runtime behavior changes.

Validation: focused delayed-worker regression, complete `test_daemon_registry.py` module, Ruff, and diff whitespace checks.
