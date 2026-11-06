# Dashboard cache concurrency and retention

Journeys were derived from the current backend audit, without an external plan:
administrators polling the same dashboard window should share its aggregation;
a slow window should not stall another; entries should have a bounded lifetime
and count; and failures/invalidation should allow safe subsequent reads.

## RED and GREEN

`uv run --project backend --extra dev pytest backend/tests/unit/test_dashboard_cache.py -q`

- RED checkpoint `553936fc`: **5 failed, 1 passed**. The tests reproduced duplicate
  builds on concurrent success/failure, a TTL consumed during the query, an
  oldest entry surviving beyond the retention cap, and an in-flight build
  repopulating the cache after `clear()`. Per-store isolation/collection already
  passed.
- GREEN checkpoint `975eec8c`: **6 passed** on the same target.
- Refactor checkpoint `5c4ff553`: cache coordination moved into the focused
  `api/admin/dashboard_cache.py` module; routes require scoped database queries
  through `SessionStore` rather than probing for retired store capabilities.
  **39 passed** across cache, dashboard API, request latency, layering, and
  module-size tests.

## Guarantees

| Guarantee | Evidence | Type |
| --- | --- | --- |
| Simultaneous polls build once; other keys progress | Paused builder, second caller, and independent window finish with one shared result | Threaded concurrency |
| A slow query receives a full TTL after completion | Controlled monotonic clock verifies a hit before and a rebuild exactly at expiry | Unit |
| Per-store completed entries stay at most 64, with recent hits preserved | Fill 64 keys, promote the oldest, insert another, and verify the least-recent key rebuilds | Unit |
| Clearing in-flight work cannot restore stale values | Clear while old builder is paused, build a fresh value, release old builder, then read the fresh value | Threaded concurrency |
| Failures wake callers and permit retry | Two concurrent callers receive the same failed build, then a later build succeeds | Threaded fault injection |
| Stores remain isolated and collectible | Same key on two stores yields separate answers; discarded store is garbage collected | Unit |
| Routes retain payloads/timezones and avoid full history | Existing dashboard and request-latency tests pass using the new cache module | API integration |

The implementation holds the cache lock only for dictionary bookkeeping. It
uses one future per active store/key to share the result, with builds and waits
outside the lock. A clear drops the store-state identity, preventing detached
builders from publishing into the new cache. All builder exits, including
interruption, resolve their waiters; failures are not cached. Completed entries
are pruned and evicted independently of active builds. Authorization still runs
before cache access.

## Validation

Focused command (prefixed with `uv run --project backend --extra dev --with coverage`):

```sh
coverage run --source=relay.api.admin.dashboard_cache,relay.api.admin.dashboard -m pytest backend/tests/unit/test_dashboard_cache.py backend/tests/api/test_dashboard.py backend/tests/api/test_request_latency.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py -q
```

**39 passed**, with **100% statement coverage** of the new cache module and
**92%** of dashboard routes/helpers (**95%** combined). Ruff passed and mypy
reported zero errors in **447 runtime files**. `pip-audit --local` reported no
known vulnerabilities. Dependency manifests are unchanged.

Full backend validation:
`uv run --project backend --extra dev pytest backend/tests -q` completed with
**3,758 passed, 28 skipped** in 514.30 seconds. No PostgreSQL test URL was set;
environment-dependent checks retained their skip requirements. No SQL or schema
was changed by this cache refactor. `npm run test:ts` completed production
package/web builds and **2,956 Node tests plus 833 React tests** successfully.
`git diff --check` passed.

No schema, frontend, or protocol wire changes are required. Coordination is per
process: each replica may build an answer. Waiters still occupy request worker
threads, and a hung database query is governed by the existing database timeout;
this does not introduce cancellation of synchronous work. Production throughput,
event-loop lag, pool wait, and dispatch latency remain to be measured against a
chosen workload as part of the broader refactoring goal.


## Next audit findings

Source inspection identified work that remains outside this completed cache
change. `persistence/session/reads.py::_read_token_usage` still returns every run
ledger row in the reporting window, including task-goal text and a session join
that the dashboard does not consume. A grouped store query could bound data
transfer by day/runtime while preserving timezone boundaries, legacy cache-token
counts, unreported runs, and deleted-thread usage. The public full-ledger method
must retain its existing response contract.

`automations/service.py::tick` collects unseeded/due routines, deliveries, and all
pending states into one Python collection under the global automation transaction
lock. `persistence/automation/store.py::list_pending_states` has no limit. The
scheduler waits for that tick before dispatch. Bounded discovery and fair progress
need review together with event delivery, occurrence atomicity, and replica
exclusion; adding a limit alone could starve routines or lose claimed events.
These observations are source evidence, not yet a regression reproduction or
performance measurement, and the overall refactoring goal remains active.
