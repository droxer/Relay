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
drops only its owned schemas in `finally`. A remote-URL rejection was verified
before a connection opened. It changes environment settings only in the probe
process and restores them afterward; it does not edit user configuration.

```sh
export RELAY_BENCHMARK_DATABASE_URL='postgresql+psycopg://USER@127.0.0.1:PORT/test_database'
uv run --project backend --extra dev python backend/tests/benchmarks/control_plane.py --output /tmp/constrained.json
uv run --project backend --extra dev python backend/tests/benchmarks/control_plane.py --scales 5 --pool-size 20 --overflow 20 --output /tmp/default-pool.json
```

There are no wall-clock pass/fail thresholds. HTTP failures, unfinished routing,
an incorrect per-routine occurrence count, or checked-out connection leaks fail
the probe. PostgreSQL namespaces were enumerated afterward: no probe schemas
remained. The cluster used for the recorded run was privately created for tests.

## Workload and instrumentation

Recorded environment: **Python 3.14.5, PostgreSQL 17.6 (Homebrew), macOS arm64**.
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

## Recorded results

All **1,350 measured HTTP requests returned 200**. Post-measurement checks found
exactly one occurrence per routine: 100 and 500 in the constrained-pool datasets,
and 500 in the default-pool dataset. No checked-out connection leaks were found.

The request column is the **highest per-endpoint p95** among five endpoint groups
(30 samples each), not a pooled/global p95. These are one local characterization
run per configuration, with setup/warm-up excluded from latency; they do not
establish production throughput or a supported capacity.

| Scale | Pool cap (base+overflow) | In flight | Workload | Measured HTTP completions/s | Highest endpoint p95 ms | Loop delay p95 / max ms | Peak checked out |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: |
| 1 | 3 (2+1) | 1 | reads | 433.21 | 4.91 | 0.93 / 1.11 | 1 |
| 1 | 3 (2+1) | 8 | reads | 323.40 | 71.98 | 3.70 / 5.15 | 3 |
| 1 | 3 (2+1) | 16 | reads + automation | 224.54 | 378.30 | 3.02 / 54.28 | 3 |
| 5 | 3 (2+1) | 1 | reads | 276.94 | 9.75 | 1.33 / 1.96 | 1 |
| 5 | 3 (2+1) | 8 | reads | 184.28 | 118.90 | 3.70 / 6.93 | 3 |
| 5 | 3 (2+1) | 16 | reads + automation | 139.28 | 371.75 | 1.66 / 69.91 | 3 |
| 5 | 40 (20+20) | 1 | reads | 252.30 | 9.54 | 1.35 / 48.91 | 1 |
| 5 | 40 (20+20) | 8 | reads | 131.71 | 236.70 | 3.83 / 6.29 | 8 |
| 5 | 40 (20+20) | 16 | reads + automation | 118.07 | 516.93 | 4.74 / 13.10 | 17 |

The measured query counts were unchanged across fixture sizes and pool settings:
three queries per thread/task summary, one per artifact read, three for the cold
session-metrics build, and one grouped query for the cold token-metrics build.
Subsequent dashboard hits issued no SQL within the measured cache window. This
is concrete work-bound evidence; it does not mean all database filtering/sorting
has constant cost.

The constrained process's peak resident high-water mark was 179.62 MiB; the default-
pool process's was 168.42 MiB. These process-wide maxima include interpreter/imports,
fixture construction, all measured phases, and prior datasets within that
process. They are not per-phase steady-state memory or a leak/long-soak bound.

A larger pool did not improve this recorded run. That observation supports
measuring a deployment's pool/worker/batch budget rather than changing defaults
from one local workload. Host scheduling, Python/JSON work, SQL work, connection
churn, and contention all contribute; the probe does not attribute a specific
bottleneck without profiling.

Raw results: [constrained pool](data/control-plane-constrained-pool.json),
[default pool](data/control-plane-default-pool.json). They retain individual
endpoint latency, response-size, query, pool-acquisition, automation tick, loop,
and process-memory measurements. Credentials, account IDs, database URLs, and
schema names are not included.

## Scope limits

ASGI transport excludes network/proxy behavior and process isolation. The
controlled automation work is one service, not multi-host worker scaling. Agent
stream ingestion, provider latency, remote database latency, sustained queue
arrival rates, long-duration soak behavior, and deployment capacity remain
operational workload questions. Replica correctness, cancellation, recovery, and
migration behavior are established separately by the complete regression suite;
this probe supplements those tests.
