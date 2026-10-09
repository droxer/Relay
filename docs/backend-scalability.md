# Backend scalability changes

The control plane keeps agent execution on daemons. This change addresses blocking task operations, historical-log write amplification, replica-local managed capacity and images, fleet-wide recovery contention, and SSE reconnect lookups.

## Implementation

- Task start/pickup preparation, dispatch preparation and result persistence, routine promotion, and task-file database reads run in worker threads. Each synchronous transaction stays on one thread; HTTP body reads and daemon transport waits stay asynchronous.
- Database session snapshots omit completed run logs. Authoritative `agent.completed` events retain those logs, and full session/detail responses hydrate them. Legacy snapshots become compact on their next write; no event history is deleted. Headers and summaries omit the logs.
- Managed capacity, attempts, enrollment grants, and profile images use the configured database. Managed lifecycle operations share validation with the local migration implementation. PostgreSQL advisory transaction locks isolate node mutations; capacity-policy changes have a separate policy lock. Profile images retain their existing 2 MiB limit, MIME validation, URLs, and ETags.
- Recovery reads at most 100 active runs and claims at most 100 run requests per pass. PostgreSQL uses `SKIP LOCKED` with a five-second recovery lease; existing dispatch/finalization claims remain authoritative. Explicit run-request updates make changed work eligible for recovery again. Recovery no longer holds the fleet dispatch lock across its scan, and monitoring does not initiate recovery.
- Retention visits at most 100 nodes and deletes at most 1,000 rows per command/run/event table per pass. It transfers IDs instead of command payloads and rotates node cursors. Partial indexes support terminal-record lookup. Admission and terminal transitions retain their existing synchronization.
- SSE reconnects retain the existing event-ID contract and use a `(session_id, payload ->> 'id')` index. Sequence-based live reads are unchanged.

## Deployment

1. Stop legacy backend writers before importing local operational state. Keep a database backup and the existing data directory.
2. Run `make backend-migrate` against the configured database. Revision `20260917_0076` adds shared operational tables and recovery metadata. Revision `20260917_0077` builds the existing-table indexes concurrently in PostgreSQL, outside the migration transaction.
3. On the host containing legacy `.relay/managed-nodes` or `.relay/profile-images`, preview and run the import using the same database configuration:

   ```sh
   uv run --project backend relay migrate-local-operational-state --data-dir /absolute/path/to/.relay --dry-run
   uv run --project backend relay migrate-local-operational-state --data-dir /absolute/path/to/.relay
   ```

   Import is transactional, rejects conflicting destination records, preserves source files and grant hashes, and reports counts without printing grant credentials. A source-directory marker prevents replay from overwriting later changes. Startup refuses to silently ignore unimported local state. New installations without local state need no import.
4. Start the new backend. For independent replicas, use `RELAY_STORAGE=postgres` so daemon operational state is also shared, and use the same database across replicas. Run schedulers/recovery through the application lifespan.

Budget database connections across processes: each process has its own configured pool and notification connection. These fixes do not establish a supported number of users or daemons; measure event-loop lag, pool wait time, stream latency, dispatch latency, recovery backlog, and database load under the intended workload.

## Rollback

Do not simply deploy old code after writing compact snapshots or shared operational state. Old code expects run logs inside session snapshots and managed state/images on disk. Restore the pre-upgrade backup or export shared operational records/images and rebuild full session projections from authoritative events before reverting. Downgrading revision `0076` removes the new operational tables. The original local files are preserved but become stale after new writes.

## Validation

See [the TDD evidence report](testing/backend-scalability.tdd.md). Tests use disposable SQLite files and a disposable PostgreSQL database/schema; no production migration or deployment is performed by this change.

## 2026-10 schema review

A review of the schema for write amplification and whole-table reads on hot paths.

### Changes

- **Streamed output is append-only.** `agent.output`, `agent.output.batch`, and `agent.collaboration` have no snapshot reducer (`SNAPSHOT_NEUTRAL_SESSION_EVENTS`), so the database store appends them with a single `version = version + 1` update instead of reading and rewriting the session snapshot (which carries every run and artifact). `version` is unindexed, so PostgreSQL applies it as a HOT update. These events no longer bump the thread's `updatedAt`; the run's `agent.started`/`agent.completed` still do.
- **Idle heartbeats touch two columns.** `mark_node_seen(node, {})` updates only `updated_at`/`last_seen_at`, with no row lock and no rewrite of the node's other columns or agent rows. Both columns are now unindexed, so the update is HOT.
- **Fewer indexes on hot rows.** `tasks` drops low-cardinality single-column indexes and the unused dispatch composite in favour of partial indexes for the scheduler's queues (`ix_tasks_dispatch_queue`, `ix_tasks_due_routines`, `ix_tasks_triggered_routines`). Event tables drop indexes that duplicate their `(parent, sequence)` unique key and unused timestamp indexes.
- **Derived columns replace JSON predicates.** `tasks.deleted_at`, `sessions.deletion_requested_at`, and `daemon_commands.run_request_id` are written from the snapshot/command by the stores' row mappers.
- **Artifact index projection.** `session_workspace_files` holds the newest `workspace_file` artifact per (thread, file), maintained on `artifact.created` and import. `GET /artifacts` is now an indexed range read instead of a walk over every snapshot.
- **Scoped workspace brief.** `GET /workspace/brief` reads the employee's thread snapshots (no event logs) and task summaries instead of every thread and task history in the system.
- **Missing lookup indexes.** `daemon_runs.command_id` (backs the `ON DELETE SET NULL` that retention triggers), `daemon_run_requests.current_command_id`, `daemon_events (type, timestamp)`, `task_sessions.session_id`.
- **Retention.** `daemon.run_request.*` events are pruned with command events. Terminal run requests are pruned after `RELAY_DAEMON_RUN_REQUEST_RETENTION_SECONDS` (default 7 days); they double as dispatch idempotency records, hence the longer window.
- **Opt-in output compaction.** With `RELAY_SESSION_OUTPUT_RETENTION_DAYS` set, the retention tick redacts the streamed output of runs that completed with a non-empty log, in threads idle longer than the window. Only the text is emptied (a batch keeps each entry's stream and sequence) and the event is marked `compacted`; nothing is deleted, so ids, sequences, event counts, and the registry's replay dedupe stay stable. Compaction is lossy for runs whose output exceeded the completed log's cap. The transcript falls back to the completed run log, which keeps the last `RELAY_RUN_OUTPUT_BUFFER_MAX_CHARS` (2 MiB) of output. Off by default.
- **Connection guards.** The application engine sets `statement_timeout` (`RELAY_DB_STATEMENT_TIMEOUT_MS`, default 30000) and `idle_in_transaction_session_timeout` (`RELAY_DB_IDLE_IN_TRANSACTION_TIMEOUT_MS`, default 60000); `0` disables either. Alembic and `relay storage-report` use their own engines and are not affected, and the compaction sweep raises its own limit. The guards are sent as the libpq `options` startup parameter; PgBouncer in transaction mode rejects it unless `ignore_startup_parameters` includes `options` — set it there or set both timeouts on the database role instead and use `0` here.
- **`task_sessions.session_id` foreign key** (`ON DELETE CASCADE`). `session_agent_runs` and `session_run_token_usage` intentionally keep no FK, so agent-run history and token usage survive thread deletion.
- **`relay storage-report`** prints table sizes and the bytes stored inline as artifact snapshots, skill blobs, and profile images. Inline content stays in the database while it is small; the report is the signal for moving it to an object store.

Not changed: `session_events` is not partitioned. PostgreSQL requires the partition key in every unique constraint, so time partitioning would lose the per-thread `(session_id, sequence)` guarantee; output compaction addresses the growth instead.

### Deployment

Run `make backend-migrate`; the backend requires `20261010_0086` at startup.

1. `20261010_0085` changes catalogs only (nullable columns, new tables, the `task_sessions` FK as `NOT VALID`) so its locks last milliseconds; `lock_timeout = 5s` makes it fail fast rather than queue behind a long transaction while every writer queues behind it. If it times out, re-run it.
2. `20261010_0086` backfills the derived columns and `session_workspace_files` in 1,000-row autocommit batches (it reads every session snapshot once), using a cast that turns unparseable timestamps into NULL, and removes `task_sessions` links to threads that no longer exist. It only fills what is missing, so it can be re-run.
3. `20261010_0087` creates and drops indexes `CONCURRENTLY`, rebuilding any index a failed concurrent build left INVALID, and validates the FK without blocking writes.

Stop old-code replicas before migrating (as for the earlier operational-state step): they do not write the derived columns, so rows they change after `0086` would show deleted tasks as live and hide pending deletions. If old replicas did write in between, repeat the backfill with `alembic downgrade 20261010_0085` followed by `alembic upgrade head`.

Streamed output no longer advances a thread's `updatedAt` (its run's start and completion still do). That keeps each chunk a HOT write; nothing reads `updatedAt` for liveness.

### Rollback

Downgrading `0086` rebuilds the dropped indexes; `0085` has nothing to undo; downgrading `0084` drops the new columns and tables. Code from before this change ignores the new columns, but it would again rewrite snapshots per output chunk. Compacted output cannot be restored.
