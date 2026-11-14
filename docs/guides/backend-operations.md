# Backend operations and upgrades

The control plane keeps execution on Daemon Nodes. This guide describes storage,
connection budgeting, bounded background work, and upgrade/rollback cautions.
Historical migration numbers below identify the changes that introduced each
contract; use [the migration guide](../../backend/migrations/README.md) to apply
all current migrations before starting the matching backend and worker release.

## Unacknowledged run cancellation

`Cancelling active run` is recorded once after a durable stop command is
published. Repeated recovery and backend restarts retain that log marker and
the same stop command ID. A stop without exit evidence for 60 seconds (about
12 five-second recovery intervals) emits one WARNING with
`recovery_reason=execution_lost`; the Thread then offers the existing report-gone
recovery action. The reservation remains held until a daemon terminal report
or an operator's recorded assertion settles it. Late exit reports still finalize
normally. No schema migration is needed.

After rollout, compare a full 24-hour worker log window against the November 13
incident: count `Cancelling active run` (target below 50) and group by run ID
(one entry per stopped run), checking the warning and subsequent reconciliation
or exit evidence for unresolved stops. The total also depends on the number of
distinct runs stopped; local regression tests cannot establish that production
metric.

## Implementation

- Task start/pickup preparation, dispatch preparation and result persistence, routine promotion, and task-file database reads run in worker threads. Each synchronous transaction stays on one thread; HTTP body reads and daemon transport waits stay asynchronous.
- Database session snapshots omit completed run logs. Authoritative `agent.completed` events retain those logs, and full session/detail responses hydrate them. Legacy snapshots become compact on their next write; no event history is deleted. Headers and summaries omit the logs.
- Managed capacity, attempts, enrollment grants, and profile images use the configured database. Managed lifecycle operations share validation with the local migration implementation. PostgreSQL advisory transaction locks isolate node mutations; capacity-policy changes have a separate policy lock. Profile images retain their existing 2 MiB limit, MIME validation, URLs, and ETags.
- Recovery reads at most 100 active runs and claims at most 100 run requests per pass. PostgreSQL uses `SKIP LOCKED` with a five-second recovery lease; existing dispatch/finalization claims remain authoritative. Explicit run-request updates make changed work eligible for recovery again. Recovery no longer holds the fleet dispatch lock across its scan, and monitoring does not initiate recovery.
- Retention visits at most 100 nodes and deletes at most 1,000 rows per command/run/event table per pass. It transfers IDs instead of command payloads and rotates node cursors. Partial indexes support terminal-record lookup. Admission and terminal transitions retain their existing synchronization.
- SSE reconnects retain the existing event-ID contract and use a `(session_id, payload ->> 'id')` index. Sequence-based live reads are unchanged.

## Deployment

1. Run `make backend-migrate` against the configured database. Revision `20260917_0076` adds shared operational tables and recovery metadata. Revision `20260917_0077` builds the existing-table indexes concurrently in PostgreSQL, outside the migration transaction.
2. Installations with unmigrated local operational state must import it with an earlier release before upgrading; the legacy file importers and startup checks have been removed.
3. Start the new backend. For independent replicas, use the same PostgreSQL database across replicas; every store, accounts included, lives there. Use embedded lifespan loops for a single development process, or the
   [external background worker](background-jobs.md) for the hosted deployment.

Budget database connections across processes: each process has its own configured pool and notification connection. Chat activation, health checks, and secret rotation also retain one dedicated coordination connection per in-flight operation; restart replicas together when adopting the coordination changes: older writers do not participate in the advisory locks. The provider guard holds a dedicated transaction through its external wait without retaining a mutable document row lock. These fixes do not establish a supported number of users or daemons; measure event-loop lag, pool wait time, stream latency, dispatch latency, recovery backlog, and database load under the intended workload.

## Rollback

Do not simply deploy old code after writing compact snapshots or shared operational state. Old code expects run logs inside session snapshots and managed state/images on disk. Restore the pre-upgrade backup or export shared operational records/images and rebuild full session projections from authoritative events before reverting. Downgrading revision `0076` removes the new operational tables. The original local files are preserved but become stale after new writes.

## Hot-path storage and retention

### Changes

- **Streamed output is append-only.** `agent.output`, `agent.output.batch`, and `agent.collaboration` have no snapshot reducer (`SNAPSHOT_NEUTRAL_SESSION_EVENTS`), so the database store appends them with a single `version = version + 1` update instead of reading and rewriting the session snapshot (which carries every run and artifact). `version` is unindexed, so PostgreSQL applies it as a HOT update. These events no longer bump the thread's `updatedAt`; the run's `agent.started`/`agent.completed` still do.
- **Idle heartbeats touch two columns.** `mark_node_seen(node, {})` updates only `updated_at`/`last_seen_at`, with no row lock and no rewrite of the node's other columns or agent rows. Both columns are now unindexed, so the update is HOT.
- **Fewer indexes on hot rows.** `tasks` drops low-cardinality single-column indexes and the unused dispatch composite in favour of partial indexes for the scheduler's queues (`ix_tasks_dispatch_queue`, `ix_tasks_due_routines`, `ix_tasks_triggered_routines`). Event tables drop indexes that duplicate their `(parent, sequence)` unique key and unused timestamp indexes.
- **Derived columns replace JSON predicates.** `tasks.deleted_at`, `sessions.deletion_requested_at`, and `daemon_commands.run_request_id` are written from the snapshot/command by the stores' row mappers.
- **Artifact index projection.** `session_workspace_files` holds the newest `workspace_file` artifact per (thread, file), maintained on `artifact.created` and import. `GET /artifacts` is now an indexed range read instead of a walk over every snapshot.
- **Scoped workspace brief.** `GET /workspace/brief` reads the user's thread snapshots (no event logs) and task summaries instead of every thread and task history in the system.
- **Missing lookup indexes.** `daemon_runs.command_id` (backs the `ON DELETE SET NULL` that retention triggers), `daemon_run_requests.current_command_id`, `daemon_events (type, timestamp)`, `task_sessions.session_id`.
- **Retention.** `daemon.run_request.*` events are pruned with command events. Terminal run requests are pruned after `RELAY_DAEMON_RUN_REQUEST_RETENTION_SECONDS` (default 7 days); they double as dispatch idempotency records, hence the longer window.
- **Opt-in output compaction.** With `RELAY_SESSION_OUTPUT_RETENTION_DAYS` set, the retention tick redacts the streamed output of runs that completed with a non-empty log, in threads idle longer than the window. Only the text is emptied (a batch keeps each entry's stream and sequence) and the event is marked `compacted`; nothing is deleted, so ids, sequences, event counts, and the registry's replay dedupe stay stable. Compaction is lossy for runs whose output exceeded the completed log's cap. The transcript falls back to the completed run log, which keeps the last `RELAY_RUN_OUTPUT_BUFFER_MAX_CHARS` (2 MiB) of output. Off by default.
- **Connection guards.** The application engine sets `statement_timeout` (`RELAY_DB_STATEMENT_TIMEOUT_MS`, default 30000) and `idle_in_transaction_session_timeout` (`RELAY_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, default 60000); `0` disables either. Alembic and `relay storage-report` use their own engines and are not affected, and the compaction sweep raises its own limit. The guards are sent as the libpq `options` startup parameter; PgBouncer in transaction mode rejects it unless `ignore_startup_parameters` includes `options` — set it there or set both timeouts on the database role instead and use `0` here.
- **`task_sessions.session_id` foreign key** (`ON DELETE CASCADE`). `session_agent_runs` and `session_run_token_usage` intentionally keep no FK, so agent-run history and token usage survive thread deletion.
- **`relay storage-report`** prints table sizes and the bytes stored inline as artifact snapshots, skill blobs, and profile images. Inline content stays in the database while it is small; the report is the signal for moving it to an object store.

Not changed: `session_events` is not partitioned. PostgreSQL requires the partition key in every unique constraint, so time partitioning would lose the per-thread `(session_id, sequence)` guarantee; output compaction addresses the growth instead.

### Deployment

The following cutover cautions apply when upgrading from before the
`20261010_0085`–`0087` storage changes. Apply all current migrations.

1. `20261010_0085` changes catalogs only (nullable columns, new tables, the `task_sessions` FK as `NOT VALID`) so its locks last milliseconds; `lock_timeout = 5s` makes it fail fast rather than queue behind a long transaction while every writer queues behind it. If it times out, re-run it.
2. `20261010_0086` backfills the derived columns and `session_workspace_files` in 1,000-row autocommit batches (it reads every session snapshot once), using a cast that turns unparseable timestamps into NULL, and removes `task_sessions` links to threads that no longer exist. It only fills what is missing, so it can be re-run.
3. `20261010_0087` creates and drops indexes `CONCURRENTLY`, rebuilding any index a failed concurrent build left INVALID, and validates the FK without blocking writes.

Stop old-code replicas before migrating (as for the earlier operational-state step): they do not write the derived columns, so rows they change after `0086` would show deleted tasks as live and hide pending deletions. If old replicas did write in between, repeat the backfill with `alembic downgrade 20261010_0085` followed by `alembic upgrade head`.

Streamed output no longer advances a thread's `updatedAt` (its run's start and completion still do). That keeps each chunk a HOT write; nothing reads `updatedAt` for liveness.

### Rollback

Downgrading `0086` rebuilds the dropped indexes; `0085` has nothing to undo; downgrading `0084` drops the new columns and tables. Code from before this change ignores the new columns, but it would again rewrite snapshots per output chunk. Compacted output cannot be restored.


## Indexed chat records and scoped histories

Revision `20261106_0116` moves audit entries and conversation bindings out of
shared JSON arrays into indexed records. It preserves full payloads and order,
including new writes when downgrading. Revision `20261106_0117` subsequently
normalizes configuration and credentials as described below. Stop old backend and worker processes before running
`make backend-migrate`; startup requires the new tables. SQLite development
installs convert their legacy arrays automatically after metadata table creation.

Audit appends no longer read/rewrite history; tail reads filter/limit in SQL.
Conversation lookups and clears use indexed keys/session IDs, and different
conversation keys no longer share a write lock. Full thread lists scope ownership
before hydrating events and split event-ID binds into batches of 500. Full
responses retain the selected records and histories.

The backfill retains source data until commit and needs maintenance time/disk
headroom. Invalid legacy records abort conversion rather than being dropped.


## Per-integration chat configuration and credentials

Revision `20261106_0117` replaces the shared configuration array with ordered
integration records and creates a separate encrypted credential row per
integration. Public metadata uses credential-key names without decrypting values;
settings decrypt only the selected integration, and runtime discovery decrypts
only active integrations. Independent integration writes use independent database
transactions and advisory locks, including when they share a store instance.
Provider-operation exclusion still applies per integration across replicas.

Stop all old backend and worker processes before `make backend-migrate`, then
start the new code with the existing `RELAY_CHAT_SECRET_KEY`. Upgrade preserves
the old credential envelope unchanged. The first access needing those credentials
converts the map atomically under a one-time database lock. Missing/wrong keys or
malformed input preserve the source for retry. SQLite converts configuration at
schema initialization and uses the same credential bridge. Startup permits the
pending encrypted envelope, but requires the normalized configuration tables.

Downgrading converted credentials requires the same encryption key in the
migration environment. It rebuilds the encrypted legacy map, including orphan
entries, and restores configuration in original order with subsequent writes.
A missing/wrong key aborts rollback atomically. Stop the new processes before
rollback and restore the old code only after downgrade succeeds.

These checks establish bounded reads and concurrent progress, not production
throughput or latency targets.


## Dashboard polling and cache retention

Admin dashboard routes require the session store's scoped metrics queries;
retired full-history fallbacks have been removed. `api/admin/dashboard_cache.py`
shares one in-flight build per store/endpoint/timezone/window within a backend
process. Unrelated keys progress independently. Completed answers expire 30
seconds after the build finishes; expired answers are pruned on access, and each
store retains at most 64 answers using least-recently-used eviction. Pending
builds exist only for active requests and are removed on success or failure.

Failures reach current waiters and allow the next request to retry. Clearing the
cache detaches old builds: existing callers finish, but their results cannot
repopulate the cleared cache. Store keys are weak references so discarded app
instances are collectible. This cache remains process-local; replicas may each
build an answer, and no distributed consistency or production capacity claim is
made. The dashboard's authorization, response, and timezone contracts are
unchanged. No database migration is required.



## Grouped dashboard token metrics

`persistence/session/metrics.py` owns session and token dashboard projections.
Token reporting uses one query over the indexed `completed_at` ledger window,
with no session join or task-goal/record metadata transfer. The query returns at
most `(day_window + 1) * (1 + distinct unreported runtimes)` groups; reporting
work in the database still scales with the matching ledger rows. Reported runs
share a single group per day, while unreported runs retain their runtime counts.
Explicit dashboard ranges use an inclusive start midnight and exclusive midnight
after the end date. Retained ledger usage survives thread deletion.

Local calendar midnights are converted to UTC query boundaries in Python,
including 23-hour and 25-hour daylight-saving days, so SQLite and PostgreSQL
follow the same reporting contract without timezone database extensions. The
series, totals, rankings, and runtime coverage notices share the selected range
(default seven days); fresh/cache arithmetic is unchanged. Ties among equal missing-run counts use latest
observation first, then runtime name for deterministic equal timestamps.

All-time reports discover retained timestamp bounds with a SQL min/max query,
then aggregate the complete history into daily, monthly (over 90 days), or
yearly (ten years or more) calendar buckets. No run histories are hydrated;
missing-usage coverage and totals include older retained runs. `bucketSize`
lets clients label monthly and yearly buckets accurately.

The full `list_token_usage` reader still returns every retained run with its
metadata. No migration is required; the existing completion-time index supports
the window predicate.


## Bounded automation discovery and routing

Each automation tick claims at most `RELAY_AUTOMATION_OUTBOX_BATCH` outbox rows
(default 200), visits at most that many listener projections across broadcasts,
and selects at most that many schedule/pending candidate IDs. Targeted manual,
webhook, retry, and outcome rows read their recipient directly. The union can
process at most three times the configured batch in distinct routines; it no
longer hydrates every routine or pending state under the global transaction lock.
A persisted round-robin candidate cursor advances even past in-flight or failing
routines, so another replica resumes fairly. Candidate queries transfer IDs,
not task snapshots, histories, or pending-event payloads.

Broadcasts page in `(created_at, id)` order and freeze the creation cutoff when
routing starts. Routines created afterward do not join that broadcast. Each page
rechecks current ownership, trigger, active-state, loop, and resume-cutoff rules.
The page cursor, pending deliveries, occurrences, failed-recipient retries, and
candidate cursor commit together. A failed recipient gets a targeted retry;
a failed outer transaction retries the same page. Standalone matcher drains now
use the same locked transaction. Partial broadcasts move behind work that has
waited longer, while all broadcasts share one projection budget per tick. Page
boundaries may defer events into a later tick; events delivered before a firing
still coalesce, and events arriving during a run remain pending for its next run.
Outbox retention deletes at most one configured batch per tick.

Stop old backend and worker processes before migrating. Revision `20261106_0118`
adds nullable routing progress and the candidate cursor table, retaining existing
outbox payloads. `20261106_0119` builds routing/retention indexes concurrently and
replaces the single-column listener index with `(created_at, id)`. Its separate
autocommit boundary permits retry from 0118; invalid indexes left by a failed
concurrent build are dropped and rebuilt. Run migrations through head before
starting the new processes. Startup rejects a missing discovery schema. Existing
SQLite databases with older automation tables also fail this check; metadata
creation does not upgrade their existing tables. Preserve their data rather than
treating a fresh SQLite fixture as a migration path.

Before rollback, let new workers finish partial broadcast routing, then stop
them. Both downgrade revisions refuse a partial cursor before changing indexes
or dropping progress fields, because old code would replay completed pages.
Unprocessed broadcasts and targeted retries can remain. No credential key is
required. Regression coverage lives in the backend automation discovery and
migration tests.
The database still filters/sorts eligible IDs and scans matching routing pages;
these work bounds do not establish production latency or capacity.

## Project MCP read migration

Revision `20261107_0121` adds `tasks.title_casefold`, backfills Python Unicode
casefold values in batches of 500 scalar rows, and adds indexes for Project
task pages and time-filtered event reads. Every task write maintains the new
projection. Stop old backend and worker writers before migrating and start
the new version afterward, so an old writer cannot leave a stale search value.
Run migrations through head before serving the new read queries.

PostgreSQL index builds run concurrently after an autocommit boundary that
commits the column/backfill. An interrupted build may be retried from 0120:
the migration reuses the column, repeats the backfill, and rebuilds invalid
indexes. Downgrade removes these indexes and the derived search column while
preserving task snapshots and event histories; stop the new application before
rolling back. SQLite fixtures also exercise upgrade, retry and downgrade.


## Backend log streams

The default logger writes levels below ERROR to stdout and ERROR/CRITICAL to
stderr, so Railway does not classify ordinary access logs as errors. Text
includes the application level and selected operational identifiers (thread,
run, permission request, Computer and command); arbitrary bound payloads and
exception local-variable values are omitted. Permission retries do not emit a
second prompt-opened INFO entry. `RELAY_LOG_LEVEL` controls the minimum level.
