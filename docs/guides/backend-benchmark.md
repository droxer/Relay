# Local control-plane workload probe

The manual probe is [control_plane.py](../../backend/tests/benchmarks/control_plane.py).
It measures real, authenticated ASGI routes against freshly migrated, owned
PostgreSQL schemas. It does not start Uvicorn, daemon/agent execution, provider
calls, or autonomous background loops. One real automation service runs in a
worker thread during the concurrency-16 phase, sharing the API pool to create
controlled contention. Its occurrence count and each routine's stored
`occurrenceIds` are checked after the measurement.

## Reproduce

Use an explicitly disposable local PostgreSQL database. The script accepts only
loopback hosts without URL query options, creates uniquely named schemas, and
drops only its owned schemas in `finally`. It changes environment settings only
in the probe process and restores them afterward; it does not edit user configuration.

```sh
export RELAY_BENCHMARK_DATABASE_URL='postgresql+psycopg://USER@127.0.0.1:PORT/test_database'
uv run --project backend --extra dev python backend/tests/benchmarks/control_plane.py --output /tmp/constrained.json
uv run --project backend --extra dev python backend/tests/benchmarks/control_plane.py --scales 5 --pool-size 20 --overflow 20 --output /tmp/default-pool.json
```

There are no wall-clock pass/fail thresholds. HTTP failures, unfinished routing,
an incorrect per-routine occurrence count, or checked-out connection leaks fail
the probe. Check afterward that the probe schemas were removed. Save generated
measurements outside the repository (for example under `/tmp`) and attach relevant results
to the performance investigation rather than adding dated reports to `docs/`.

## Workload and instrumentation

Record the Python/PostgreSQL versions and host environment with each run.
Each phase sends 150 closed-loop requests with 1, 8, or 16 in flight, evenly split
among capped thread summaries (100), task summaries (100), artifacts (50), session
metrics, and token metrics. The two fixture sizes are:

| Scale | Threads | Stream events per thread | Stream text | Plain tasks | Event-triggered routines |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 25 | 20 | 2,048,000 bytes | 100 | 100 |
| 5 | 125 | 20 | 10,240,000 bytes | 500 | 500 |

Each thread also has start/completion/artifact events and normalized token usage.
The fixture is populated through actual stores, outside timing. A synthetic
broadcast visits every seeded routine with batch size 25; it creates occurrences
without dispatching agents. Source authentication is real, with generated local
credentials; the account cache and the base connection pool are warmed. Dashboard
answers are cleared at each phase's start, exercising cold builds and subsequent
cache hits. The configured overflow may still open/close connections during load.

Request latency starts after the client semaphore grants an in-flight slot;
completion throughput uses the duration of all 150 HTTP requests. SQL counts
follow request context into worker threads. Pool acquisition measures the public
pool `connect()` call and includes queueing, connection creation, pre-ping, and
checkout overhead; it is **not a pure queue-wait metric**. The event-loop sampler
checks excess delay beyond a 5 ms sleep through the entire phase, including any
automation work remaining after the HTTP requests finish. Its p95 therefore is
not solely an interactive-traffic interval; maxima are retained too.

## Scope limits

ASGI transport excludes network/proxy behavior and process isolation. The
controlled automation work is one service, not multi-host worker scaling. Agent
stream ingestion, provider latency, remote database latency, sustained queue
arrival rates, long-duration soak behavior, and deployment capacity remain
operational workload questions. Replica correctness, cancellation, recovery, and
migration behavior are established separately by the complete regression suite;
this probe supplements those tests.
