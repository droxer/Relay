# Default agent recovery fixes

The review supplied three requirements: interrupted seeding must recover,
retries must not create defaults on newly enrolled Computers, and a stale
accept must respect an earlier decline.

## Changes and evidence

| Guarantee | Regression test | RED | GREEN |
| --- | --- | --- | --- |
| Interrupted work rolls back agents and placements and retries on the next boot | `test_interrupted_seed_rolls_back_and_retries` | Agents remained after interruption | Pass |
| A failed seed retains its original eligibility cutoff | `test_failed_seed_retry_excludes_new_computers` | Retry created three agents instead of one | Pass |
| Seeding respects saved declines | `test_seed_honors_declines` | Both runtimes were created | Pass |
| A stale accept respects declines, including with stale session-cache data | `test_stale_accept_respects_saved_decline` | Accept created a declined agent | Pass |
| Mixed accepts create only unanswered runtimes | `test_accept_mixed_answer_creates_only_unanswered_runtimes` | Additional verification | Pass |
| Concurrent workers execute once; failed work retains its cutoff | `test_run_once.py` | Additional verification | Pass |
| Concurrent accepts create one default and both return successfully | `test_concurrent_accepts_create_one_default` | Additional verification | Pass |

Focused validation:

```sh
UV_CACHE_DIR=/private/tmp/relay-review-uv uv run --project backend --extra dev pytest \
  backend/tests/unit/test_run_once.py \
  backend/tests/api/test_default_agent_offers_api.py \
  backend/tests/unit/test_default_agent_seed.py \
  backend/tests/unit/test_node_agents.py \
  backend/tests/unit/test_onboarding_preferences.py -q --tb=short
```

Result: **65 passed**. Backend `ruff check` and `mypy` pass. Authorization,
layering, module-size, and API state-access guards also pass (12 tests).

Full backend validation (`uv run --project backend --extra dev pytest
backend/tests -q --tb=short`): **3,141 passed, 32 skipped, 2 failed** in
440.35 seconds. Both failures were installer tests denied access to `/dev/tty`
by the sandbox. Rerunning those two tests outside the sandbox passed (2/2).
The focused run above additionally covers tests added after the full suite
began collecting. `git diff --check` passes.

## Recovery contract

The maintenance record first commits a pending state and a fixed cutoff.
The job then holds a database resource lock and commits its writes and done
marker together. Interruptions roll back that transaction, leaving pending
work retryable. Persisting the initial cutoff is required before serving;
failing to persist it fails startup, because serving without it could widen
eligibility on a later attempt. Failures after initialization remain nonfatal.

Accept and decline requests serialize per Account. Accept reads current
preferences from storage within that transaction rather than trusting the
session cache.

## Limits

The tests use SQLite. PostgreSQL uses the existing transaction-scoped advisory
lock implementation and was not exercised against a live database. Coverage
tooling is not installed in the backend environment;
no numeric coverage percentage is claimed.

## PR validation after rebasing onto main

- The focused backend tests and architecture/auth guards pass together: 77 tests.
- Backend mypy (381 source files), ruff, package and web TypeScript checks,
  CSS lint, and all applicable pre-commit hooks pass.
- Web offer unit tests pass (5 tests).
- `npm run build -w web -- --webpack` passes. Turbopack cannot bind its CSS
  compiler's subprocess port in this environment.
- The initial browser run exposed an assertion race: dialog closure precedes
  completion of the accept request. The test now polls for the expected wire
  requests. `npx playwright test -c playwright.recovery.config.ts
  defaultAgentsPrompt.spec.ts --workers=1 --repeat-each=3` passes (12 tests).
- `npm audit --registry=https://registry.npmjs.org` reports 12 existing
  advisories: 1 critical, 6 high, 5 moderate. Dependency manifests and the
  lockfile are unchanged by this feature.
