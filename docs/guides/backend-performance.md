# Backend API performance review

The review covered the registered HTTP routes under `backend/relay/api` and
the MCP transport mounted in `backend/relay/app.py`. The inventory contained
280 backend route declarations plus two web fallbacks. Compatibility aliases
and distinct HTTP verbs count as separate declarations. The review followed
both reads and writes into their shared store or transport paths and checked
scope, history hydration, fan-out, and pagination. Synthetic load probes
cover the workflows listed below.

| Route group | Performance checks |
| --- | --- |
| Accounts | Checked cookie session reuse, password work factors, user and waitlist pages, notification counts, image delivery, and owner-scoped tag reads and writes. |
| Admin | Checked the dashboard's cached aggregates, period limits, metrics snapshots, and single-record policy changes. |
| Agents, Teams, and Skills | Checked summary hydration, roster and Placement fan-out, revision pages, blob reads, and Workflow reads and writes. Personal Teams now read the Computers their members use. |
| Chat | Checked indexed conversation resolution, bounded audit reads, and provider coordination. Mapping a conversation now reads the linked Thread header. |
| Computers and daemon transport | Checked owner-scoped inventory, token lookup, leases, output ingest, heartbeat persistence, and live workspace requests. The shared Sandbox actor lookup now scopes candidate reads by credential. |
| Connections | Checked owner/target scopes, resource and usage list bounds, OAuth callbacks, and provider tool dispatch. Provider round trips are external to the local probe. |
| Projects and MCP | Checked summary and record reads, Workflow scope, tool pagination, proposal writes, and workspace calls. MCP Project and Computer lookups now apply the grant's scope before hydration. |
| Tasks and Automations | Checked Issues and board windows, occurrence ledgers, Activity, wait status, and generated files. Global Issues now pages scalar filters and sorts in SQL. Workspace wait polls use indexed run lookups, and artifact rollups batch linked Thread metadata. |
| Threads and streaming | Checked directory paging, execution-state annotation, transcript byte and event bounds, SSE resume, queue metadata, attachment reads, and run controls. Annotating a page now batches Computer liveness, and Activity history has its own cursor. |
| Web fallbacks | Checked static file delivery, fingerprinted asset caching, and conditional responses. |

## Regression budgets

- SQLite tests and a focused PostgreSQL CI step check page bounds, scoped
  queries, returned row counts when supported, and access and response parity.
- React and Chromium check Activity history requests separately from the
  conditional first-page poll. The browser loads older pages on demand and
  keeps loaded history visible after a `304`.
- `backend/tests/benchmarks/control_plane.py` measures summary, Issues,
  Activity, artifact, and dashboard reads on disposable local PostgreSQL.
  It reports latency percentiles, SQL statements, SQL rows returned to the
  application, and decoded HTTP bytes. The sibling `heartbeat_load.py` and
  `daemon_transport.py` probes cover daemon traffic.

The control-plane probe takes an explicit loopback database URL and writes
its results outside the checkout.

```sh
RELAY_BENCHMARK_DATABASE_URL=postgresql+psycopg://relay@127.0.0.1:5432/relay_test \
  uv run --project backend --extra dev python backend/tests/benchmarks/control_plane.py \
  --scales 1 6 --requests 70 --output /tmp/relay-control-plane.json
```

The probe uses an owned scratch schema for each dataset.

## Workloads that still scale with history

- Global Issues text, tag, and assignee filters and locale-sensitive sorts
  keep the existing Python comparison rules. The SQL window still computes
  exact collection counts and tag facets when selected.
- Older API clients can request complete Thread or Task records, unpaged
  Activity, and complete chat conversation histories. Some Task artifact
  rollups still return every distinct result requested by the caller.
- The local probe measures selected workflows. Production queueing,
  provider round trips, connection-pool contention across replicas, and
  latency at larger data scales need deployment measurements.
