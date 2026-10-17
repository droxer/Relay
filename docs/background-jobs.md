# Background jobs

Relay uses Procrastinate 3.10.0 for a standalone Python control-plane worker.
It shares PostgreSQL with the API and needs no separate message broker.
The API continues to accept requests while the worker schedules background
checks. Daemon Nodes continue to execute every Agent Runtime.

## Start locally

Set these in `backend/.env` for both processes:

```dotenv
RELAY_STORAGE=postgres
RELAY_BACKGROUND_MODE=external
RELAY_DATABASE_URL=postgresql+psycopg://relay:relay@localhost:5432/relay
```

Use your installation's actual database URL. `DATABASE_URL` is also accepted;
`RELAY_DATABASE_URL` takes precedence. The worker translates SQLAlchemy's
driver-qualified URL into psycopg connection parameters, preserving encoded
credentials, SSL settings, and connection options.

Apply Relay migrations and the queue schema, in order:

```bash
make backend-migrate
make backend-worker-schema
```

Then start each long-running process in its own terminal:

```bash
make backend
```

```bash
make backend-worker
```

The equivalent installed CLI commands are `relay worker-schema` and
`relay worker`. The worker initializes Relay's stores and services using the
same application factory as the API, but binds no HTTP socket. Startup fails
if shared PostgreSQL storage is not configured or the queue schema is absent.
Use the same domain configuration, credentials, and data directory for both
processes. `--data-dir` is accepted by the worker.

`RELAY_BACKGROUND_MODE=embedded` remains the default for compatibility and
SQLite-backed tests. It runs the existing periodic loops inside the API and
does not use Procrastinate. In external mode the API starts no task-scheduler,
computer-notification, or execution-recovery loop. It still produces durable
automation outbox events. Keep `RELAY_TASK_SCHEDULER_ENABLED=1` on both
processes when scheduling is desired; setting it to `0` disables scheduling
and task/session automation event production, regardless of background mode.

## Scheduled work

| Job | Default interval | Responsibility |
| --- | --- | --- |
| `relay.scheduler` | 10 seconds | Existing automation tick and task dispatch, including project tasks |
| `relay.computer_notifications` | 15 seconds | Computer liveness/version transitions and notification pruning |
| `relay.execution_recovery` | 5 seconds | Existing execution evidence and pending-deletion recovery |
| `relay.recover_stalled_jobs` | 1 minute | Release abandoned control-check jobs after worker heartbeat loss |
| `relay.prune_jobs` | 1 hour | Remove terminal control jobs older than 7 days |

`RELAY_TASK_SCHEDULER_INTERVAL_SECONDS` and
`RELAY_NOTIFICATION_WATCH_INTERVAL_SECONDS` retain their existing defaults.
In worker mode intervals must be whole seconds that divide a minute, hour,
or day: for example 5, 10, 15, 30, 60, 120, or 3600. Unsupported intervals fail
at worker construction rather than silently changing cadence. Embedded mode
continues to accept the existing arbitrary intervals.

User-defined automation schedules remain in Relay's automation store. They
are not duplicated as Procrastinate schedules. The periodic scheduler calls
the existing service, which owns due-date, timezone, admission, failure, and
dispatch semantics.

Each domain check has an execution lock across workers and a queueing lock
that permits only one pending check of that kind. Successful checks are
deleted; failed checks remain inspectable for 7 days. There are three
concurrent job slots, and synchronous store work runs off the event loop.
Graceful termination waits for outstanding store writes.

Periodic deferral deduplicates schedule slots across worker instances. Job
delivery is not an exactly-once guarantee: a worker that loses its heartbeat
can later resume. Domain transactions, dispatch claims, and notification
compare-and-set writes remain essential. A missed control check is recovered
by a later scan of durable state, rather than replaying every missed timer
tick. Existing automation policy decides whether a due occurrence is fired.

The stalled-job check only changes Relay's known `relay_control` checks. It
marks an abandoned check failed, allowing the next scheduled check to run;
it does not retry agent executions, infer daemon exit, or release delivered
execution reservations. Maintenance itself has no execution lock, so a
crashed maintenance worker cannot prevent its own recovery.

## Schema ownership and operations

`relay worker-schema` installs the vendor schema only if the main queue table
does not exist. It is an initial-install command, not a schema repair or
upgrade tool. Run it once during provisioning, before starting workers. API
and worker startup never apply DDL. Queue tables, enums, functions, and
triggers are owned by Procrastinate, outside Relay's Alembic metadata, in the
configured PostgreSQL search path. Alembic autogeneration excludes reflected
`procrastinate_*` tables so it does not propose deleting them. Other unknown
tables continue to surface as drift. The database role needs DDL permissions
for the explicit install step.

The dependency is pinned to 3.10.0. Upgrading it requires reviewing and
applying the vendor's incremental SQL migrations before upgrading workers;
do not reapply the initial schema over an existing installation. Vendor SQL
is available under the installed `procrastinate/sql/migrations/` directory.

Procrastinate writes worker/job logs through Relay's standard logging setup
and maintains worker heartbeats in `procrastinate_workers`. Useful read-only
operator queries (using the same search path) are:

```sql
SELECT id, last_heartbeat FROM procrastinate_workers;
SELECT queue_name, task_name, status, count(*)
FROM procrastinate_jobs
GROUP BY queue_name, task_name, status;
SELECT id, task_name, scheduled_at
FROM procrastinate_jobs
WHERE status = 'todo'
ORDER BY scheduled_at NULLS FIRST, id;
```

Supervise `relay worker` as a separate process and restart it on failure.
Begin with one worker. To return to embedded processing, stop the standalone
workers, change the API to `RELAY_BACKGROUND_MODE=embedded`, and restart it.
Keep the queue schema; it is not necessary to delete persisted state.

## Current scope

This integration moves existing periodic control-plane work onto
Procrastinate. Task-completion inbox notifications still commit with task
changes. Password-reset and waitlist emails still use their existing
request/background callbacks; durable email delivery is a subsequent change
that must preserve atomic enqueueing, uniform public responses, token
confidentiality, expiry, and delivery-status semantics.

## References

- [Procrastinate worker configuration](https://procrastinate.readthedocs.io/en/stable/howto/basics/worker.html)
- [Periodic jobs and dynamic schedules](https://procrastinate.readthedocs.io/en/stable/howto/advanced/cron.html)
- [Stalled jobs](https://procrastinate.readthedocs.io/en/stable/howto/production/retry_stalled_jobs.html)
- [Transactional enqueueing](https://procrastinate.readthedocs.io/en/stable/howto/production/external_connection.html)
