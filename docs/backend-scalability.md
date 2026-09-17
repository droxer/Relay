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
