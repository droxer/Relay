# Automations

An Automation is a routine Task definition. A trigger creates an occurrence,
which uses the normal Task dispatch path to a Daemon Node. The backend never
executes an Agent Runtime. The product says Automations; storage, events, and
API fields retain `routine*` names.

## Configure and operate

- Choose up to five triggers, combined with OR: schedule, Task event, run event,
  or webhook. At most one webhook is allowed. No triggers means Run now only.
- Schedules support hourly, daily, weekday, weekly, monthly, one-off, and
  five-field cron forms. Cron fires no more often than every 15 minutes.
  Select an IANA timezone; an unspecified zone uses
  `RELAY_TASK_SCHEDULER_TIMEZONE`, then the server's zone.
- Pause a definition to stop automatic firing. Run now remains available on an
  owner-paused definition, subject to admission and rate limits.
- A Relay pause records a cause: rate limit, repeated failed occurrences,
  missing target, or invalid schedule. Resolve the cause and use Resume.
  Resume clears pending events and recomputes the next scheduled run.

Three consecutive failed occurrences pause an active definition. A failed
agent turn inside a round is not itself a failed occurrence. Schedule fires
are exempt from the non-schedule hourly cap
(`RELAY_AUTOMATION_MAX_RUNS_PER_HOUR`, default 6).

Use the [API reference](../api.md) for the exact trigger schema, failure-counting
rules, owner/assignee permissions, preview, Run now, Resume, and webhook endpoints.
Webhook tokens go in `X-Relay-Automation-Token`, never in a URL; rotation returns
a plaintext token once and stores only its hash.

## Delivery and recovery

Every trigger passes through the same pending state. Firings coalesce behind a
running occurrence; missed schedule slots collapse into one catch-up. Pending
events expire after 24 hours. Self-origin events, own occurrences, and chains
beyond depth 3 are excluded.

Task and session stores produce transactional `automation_outbox` records.
`backend/relay/automations/` owns normalization, schedule evaluation, the clock,
matching, and firing. Persistence owns routing projections and cursors; the
scheduler invokes the service and dispatches ready Tasks.

Discovery and routing are bounded by `RELAY_AUTOMATION_OUTBOX_BATCH`. Broadcast
pages, pending delivery, occurrence creation, and routing progress commit
together. See [backend operations](backend-operations.md#bounded-automation-discovery-and-routing)
for scaling and migration cautions, and [background jobs](background-jobs.md)
for the worker configuration.

## Compatibility and upgrades

Use `routineTriggers`, `routineState`, and `routineNextRunAt` for new writes.
Legacy events still replay through the pure model upgrade. A legacy definition
with no next date becomes Run-now only. The clock seeds missing next-fire times
because a reducer cannot resolve the server's timezone.

Apply migrations before starting the matching backend and worker release; follow
[the migration guide](../../backend/migrations/README.md). During a legacy-to-v2
cutover, stop the old scheduler: it does not share the v2 transaction lock.
Regression tests live in `backend/tests/` and `web/tests/`; completed delivery
plans and test transcripts are retained in Git history.
