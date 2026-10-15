# Waitlist review fixes

Source: the review of the uncommitted waitlist feature and
[waitlist design](../waitlist-design.md). The feature and its review fixes are
kept together in one pull request.

## Guarantees and regression evidence

| User journey | Regression | RED | GREEN |
| --- | --- | --- | --- |
| An invitee creates one account even when an admin resends concurrently | `test_active_claim_cannot_be_reinvited` in `backend/tests/unit/test_waitlist_service.py` | Re-invite did not raise a conflict inside the account-creation callback | Active claims reject re-inviting; ordinary failed account creation still releases the claim |
| Concurrent visitors cannot exceed the waiting queue's configured capacity | `test_concurrent_joins_respect_capacity` in the same file | A cap of one admitted both synchronized joins | One join succeeds and one is refused; count remains one |
| An admin sees background delivery failures without reloading | Last test in `web/interaction-tests/adminWaitlist.test.tsx` | Delivery remained queued after advancing the polling clock | Table updates to failed and link reveal contains no stale queued status |

The existing stranded-claim test now requires unlinked claims to stay closed:
an empty account link cannot prove that account creation has stopped.

## Validation

- Backend RED: `uv run --project backend --extra dev pytest backend/tests/unit/test_waitlist_service.py -q` — 3 failed, 27 passed (the two added regressions and the changed unlinked-claim requirement).
- Web RED: `npm run test:react -w web -- interaction-tests/adminWaitlist.test.tsx` — 1 failed, 3 passed; no delivery failure appeared after the simulated interval.
- Backend GREEN: waitlist service/API, mailer, rate limiter, and agent-placement tests — 83 passed. Command: `UV_CACHE_DIR=/tmp/relay-review-uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_waitlist_service.py backend/tests/unit/test_cloudflare_mailer.py backend/tests/unit/test_rate_limit.py backend/tests/api/test_waitlist_routes.py backend/tests/unit/test_agent_placements.py -q`.
- Web GREEN: `npm run test:react -w web -- interaction-tests/adminWaitlist.test.tsx interaction-tests/joinScreen.test.tsx interaction-tests/waitlistScreen.test.tsx` — 14 passed.
- Full web interaction suite: `npm run test:react -w web` — 73 files, 483 tests passed.
- Type check: `npx tsc --noEmit -p web/tsconfig.json` — passed.
- `git diff --check` — passed after removing the extra trailing blank line in `docs/api.md`.

## Limits

Concurrency regressions exercise real SQLite transactions. PostgreSQL uses the
existing `resource_transaction` advisory-lock helper; a live multi-replica
PostgreSQL deployment was not exercised. No new browser E2E run or coverage
percentage was measured for these fixes. Tests capture account-creation
callbacks, database admission, and the rendered admin view directly.
