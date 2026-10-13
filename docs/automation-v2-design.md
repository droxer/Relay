# Automations v2 design: trigger model, firing, and the automations seam

Status: implemented (PR 2, 2026-10-13); see the plan's deviations:
`docs/plans/2026-10-13-automation-v2.md#deviations-from-the-spec-decided-while-planning`.

Supersedes the data model and firing sections
of `docs/automation-triggers-design.md`; that document's outbox, webhook, and
rename sections still hold. The setup-flow redesign (a dedicated automation
composer) is a separate follow-up spec built on this contract.

## Goal

Automations shipped with a single trigger, a date-only schedule, and concepts
that do not earn their place. This revision:

1. Makes the trigger model expressive: time-of-day, weekday, and cron
   schedules with a timezone, and several triggers per automation.
2. Removes confusing concepts: the Issue/Job type, the "manual" kind, the
   `custom` cadence, and the enabled switch plus disabled reason.
3. Puts every trigger through one firing path, and lets Relay pause an
   automation that keeps failing.
4. Gathers the automation logic now spread across `tasks/scheduler.py`,
   `api/task_routes.py`, and `automations/` into one package.

### Decisions

| Question | Decision |
|---|---|
| Schedule expressiveness | Structured presets (hour, day, weekday, week, month, once) plus an advanced 5-field cron, each with an IANA timezone. |
| Triggers per automation | 0..5, OR-ed. Zero triggers means Run-now only. At most one webhook. |
| Coalescing, rate cap, loop guards | Per automation, shared by all of its triggers. |
| State | `routineState: active \| paused \| paused_by_relay` with a reason. |
| Repeated failure | Relay pauses after 3 consecutive failed occurrences. |
| Legacy data | Additive v2 fields; the reducer upgrades legacy fields on replay. No write migration of events. |
| Cron evaluation | Backend only, via `croniter` behind `automations/schedule.py`. The web asks a preview endpoint. |

### Invariants carried forward

- The backend never executes agents. Triggers only queue occurrences; daemon
  dispatch is unchanged.
- The event log is authoritative. v2 fields ride `task.created` /
  `task.updated`; materialized columns are derived from the snapshot.
- Automations are routines on the wire: fields, columns, and events keep
  `routine*` names.
- An automation's runs pass through `assertSessionOwnedByEmployee`.

### Out of scope

- The new setup UX (When → Do → Who/Where composer, templates). The web
  changes here only adapt the existing drawer to the v2 contract.
- GitHub-native and chat triggers, template variables, per-trigger rate caps.

## 1. Data model

```
routineTriggers: Trigger[]            // 0..5, OR-ed; [] = Run-now only
Trigger =
  | { kind: "schedule",   schedule: Schedule }
  | { kind: "task_event", on: "created" | "status_changed", filters?: Filters }
  | { kind: "run_event",  on: "completed" | "failed",       filters?: Filters }
  | { kind: "webhook" }                                     // at most one
Schedule = {
  timezone: string | null,            // IANA; null = server default
  repeat:
    | { every: "hour",    minute: 0..59 }
    | { every: "day",     at: "HH:MM" }
    | { every: "weekday", at: "HH:MM" }                // Mon–Fri
    | { every: "week",    at: "HH:MM", days: (1..7)[] } // ISO weekdays, non-empty, unique
    | { every: "month",   at: "HH:MM", day: 1..31 }     // clamps to month end
    | { once: "YYYY-MM-DDTHH:MM" }
    | { cron: string }                                   // 5-field
}
routineState: "active" | "paused" | "paused_by_relay"
routinePauseReason?: "rate_limited" | "failing" | "no_target" | "invalid_schedule"
routineNextRunAt?: string             // ISO datetime, UTC; computed at write time
```

`Filters` is unchanged from v1 (`projectId`, `assignedAgentId`,
`assignedTeamId`, `fromStatus`, `toStatus`, `priority`, `titleContains`), with
the same allowlist and assignment-permission checks.

### Rules

- Presets are stored structured so the web round-trips them without parsing
  cron. `schedule.py` compiles each to a croniter expression.
- A `cron` schedule must not fire more often than every 15 minutes. The check
  samples the next 50 fire times and rejects any gap under 15 minutes.
- `timezone: null` resolves to `RELAY_TASK_SCHEDULER_TIMEZONE`, else server
  local — the same rule as today. New automations created from the web send
  the browser's zone.
- `routinePauseReason` is present only with `paused_by_relay`. Owners may set
  `active` or `paused`; only Relay sets `paused_by_relay`. Setting `active`
  clears the reason.
- `routineNextRunAt` is the earliest next fire across the schedule triggers,
  computed by `AutomationService` / the clock and carried on the event. The
  reducer stores it; it never evaluates cron. It is absent when there is no
  schedule trigger, the automation is not active, or a `once` has fired.
  Resuming recomputes it from the resume time, so a paused automation never
  fires a backlog of missed slots.

### Dropped fields

New events no longer write `routineType`, `routineCadence`,
`routineNextRunDate`, `routineEnabled`, `routineDisabledReason`, or the
singular `routineTrigger`. The API answers 400 when a write carries them.
Replay still reads them.

### Legacy upgrade on replay

`automations/model.upgrade_legacy(task)` is pure and called by
`store_common._apply_task_routine_fields` whenever an event carries legacy
fields and no v2 equivalent:

| Legacy | v2 |
|---|---|
| `routineTrigger.kind = schedule` (or absent), cadence `daily` | `[{schedule: {timezone: null, repeat: {every: "day", at: "00:00"}}}]` |
| cadence `weekly`, next run date D | `{every: "week", at: "00:00", days: [isoweekday(D)]}` |
| cadence `monthly`, next run date D | `{every: "month", at: "00:00", day: D.day}` |
| cadence `custom`, next run date D | `{once: "D T00:00"}`; no date → `[]` |
| `routineTrigger.kind = manual` | `[]` |
| `routineTrigger` event / webhook kind | `[that trigger]` |
| `routineEnabled: true` | `active` |
| `routineEnabled: false`, reason `rate_limited` | `paused_by_relay` / `rate_limited` |
| `routineEnabled: false`, other | `paused` |
| `routineNextRunDate: D` | `routineNextRunAt` = D 00:00 in the server timezone |
| `routineType` | dropped |

With a null timezone, legacy routines keep firing at start of day in the
server zone, exactly as today.

### Materialized columns (one Alembic migration)

- Add `tasks.routine_next_run_at timestamptz null` and
  `tasks.routine_state text null`, with a partial index on
  `routine_next_run_at` where `is_routine and routine_state = 'active'`.
- Backfill both by replaying each routine's snapshot through the reducer.
- `routine_next_run_date` and `routine_enabled` stay, unread, until a later
  cleanup migration drops them and their indexes.
- `automation_state` gains `consecutive_failures int not null default 0`.

## 2. Firing: one path for every trigger

```
clock (schedules) ─┐
outbox matcher ────┼─► automation_state.pending (coalesced) ─► firing ─► promote occurrence ─► daemon dispatch
webhook / Run now ─┘
```

### Clock step (replaces `_promote_due_routines`)

Each tick, `clock.py` lists active routines with
`routine_next_run_at <= now` (the indexed column). For each one, in one
transaction:

- mark it pending with a `schedule` event naming the schedule's summary;
- append `task.updated` with the next `routineNextRunAt` computed strictly
  after `now`.

Missed slots (backend down) collapse into one catch-up run. A `once` schedule
leaves no next run after it fires. A schedule that fails to compile pauses the
automation with `invalid_schedule`.

### Matcher

Unchanged except that a broadcast row is matched against every trigger of
each automation; the first matching trigger marks it pending. Loop guards
(self-origin, own occurrence, depth > 3) are unchanged. Addressed rows
(webhook, Run now) match only their automation.

### Firing (`firing.py`, split out of `matcher.py`)

For each pending automation:

1. **Occurrence in flight:** stay pending. This now applies to schedules too,
   so a slow run no longer stacks a second one. Deliberate behavior change.
2. **Rate cap:** event, webhook, and Run-now fires count toward
   `RELAY_AUTOMATION_MAX_RUNS_PER_HOUR` (default 6); schedule fires do not —
   the 15-minute floor bounds them. Reaching the cap sets
   `paused_by_relay` / `rate_limited` and clears pending.
3. **No target:** no agent, team, or project, or the project fails
   `project_work_error`, sets `paused_by_relay` / `no_target` and clears
   pending. This replaces the repeated `_record_routine_skip` activity.
4. **Otherwise:** promote an occurrence with the Trigger context block and the
   occurrence stamps (`routineTriggerKind`, `routineTriggerSummary`,
   `routineTriggerDepth`). `routineTriggerKind` gains the value `schedule`; the
   block gains a `Fired by: Schedule (<summary>)` line.

Pending events older than 24 hours are still dropped and shown in the ledger.

### Auto-pause on failure

`automation_state.consecutive_failures` counts finished occurrences:
`run.failed` increments it, `run.completed` resets it, a human cancel does
neither. At 3, Relay sets `paused_by_relay` / `failing`. Resume resets it.

### Run now

Allowed in every state except `paused_by_relay` / `rate_limited`. It goes
through the pending path and does not change the state.

## 3. Code structure and API

`backend/relay/automations/` is the one seam; nothing outside it reasons
about triggers, schedules, or automation state.

| Module | Holds | Moved from |
|---|---|---|
| `model.py` | Pure normalize/validate of `routineTriggers` and `routineState`, `upgrade_legacy`, trigger ↔ event-type tables | `trigger.py`; `routine_fields` validation in `task_routes.py` |
| `schedule.py` | Pure preset → croniter compile, `next_fire_after(schedule, after)`, the 15-minute floor, the English summary | `next_routine_date`, `_add_interval`, `_add_month` in `scheduler.py` |
| `clock.py` | The due-schedule step | `_promote_due_routines`, `_routine_due`, `_due_routines`, `_record_routine_skip` |
| `matcher.py` | Outbox drain and match | — (firing moves out) |
| `firing.py` | Pending → coalesce / cap / no-target / auto-pause → promote | `matcher._fire`, `_fire_one` |
| `context.py` | Trigger context block text | `trigger.trigger_context_block` |
| `service.py` | `AutomationService`: save triggers (computes `routineNextRunAt`), pause / resume, Run now, webhook secret, preview, and `tick(now)` | logic in `task_routes.py` and `automation_routes.py` |

- `TaskScheduler._tick_sync` becomes `automations.tick(now)` then
  `_dispatch_assigned_tasks`. `scheduler.py` keeps dispatch only.
- Both stores replace `promote_due_routine(routine_id, today, next_run_date)`
  with `promote_occurrence(routine_id, *, stamp)`; date logic leaves the
  stores. Occurrence building stays in `store_common.routine_occurrence_events`.
- `croniter` joins `backend/pyproject.toml` dependencies.

### API

All automation handlers live in `automation_routes.py`:

- `POST /tasks`, `PATCH /tasks/{id}`: accept `routineTriggers` and
  `routineState`, validated by `model.py`; 400 on legacy fields.
- `POST /tasks/{id}/runs` (Run now): path unchanged; handler moves.
- `POST /tasks/{id}/automation/resume`: owner or admin; clears
  `paused_by_relay` and resets the rate window and failure counter.
- `POST /automations/schedule-preview` with `{schedule}`: answers
  `{summary, next: [3 ISO datetimes]}` or 400 with the validation message.
- Webhook routes unchanged. `capabilities.automationTriggers` still gates
  non-schedule kinds.

### Web (contract adaptation only)

- `types.ts`, the `automationTrigger.ts` mirror, and `routine.ts` move to v2;
  cadence and type go.
- The existing drawer edits one trigger: schedule preset picker with time and
  days, cron as an advanced field with a live preview from the endpoint, or
  one event trigger, or webhook. An automation with several triggers shows
  them read-only ("3 triggers") until the composer spec lands.
- The pause banner (rate limited, failing, no target, invalid schedule) with
  Resume replaces the rate-limit banner.
- The list's Cadence column becomes Next run; the Type column and filter go.
- New strings land in `en` and `zh-CN`.

## 4. Error handling

- Validation answers 400 naming the field path, e.g.
  `routineTriggers[1].schedule.repeat.at`: below the cron floor, unknown
  timezone, over 5 triggers, two webhooks, legacy fields on write.
- A stored trigger that cannot evaluate is a non-match plus a warning with
  the routine id. A schedule that cannot compile pauses with
  `invalid_schedule`.
- The clock writes the pending mark and the next-run advance in one
  transaction; a crash re-fires at most once.
- Every pause, coalesce, catch-up collapse, and depth drop is logged with the
  routine id and trigger kind.

## 5. Testing (tests first)

Python unit:

- `schedule.py`: each preset compiles; `next_fire_after` across DST
  spring-forward and fall-back (America/New_York, Europe/London); month-end
  clamping; `once` fires once; cron floor; summaries.
- `model.py`: the full legacy upgrade table; normalize round-trip; every
  validation error.
- Reducer replay: legacy streams produce the expected v2 snapshot; mixed
  legacy and v2 streams.
- Clock: due routine fires; missed slots collapse to one; in-flight
  occurrence coalesces; `once` clears its next run.
- Firing: multi-trigger OR; rate cap excludes schedule fires; no-target pause;
  three failures pause, a success resets, a human cancel does not count; Run
  now while paused.

Python API: v2 create/patch; legacy fields rejected; preview; resume; owner
vs other 403.

Migration: backfill of `routine_next_run_at` / `routine_state` from replayed
snapshots, on SQLite and on Postgres (`postgres` marker).

Integration: a weekday 09:00 schedule fires a dispatch through the fake
daemon path at the right instant.

Web: mirror validation; drawer round-trip per preset; Next run column; pause
banner; locale keys present in both languages.

## 6. Delivery

1. **Restructure, no behavior change.** Move code into `automations/`
   (`clock`, `firing`, `context`, `service`); slim `scheduler.py` and
   `task_routes.py`. Existing tests pass unmodified.
2. **v2 model.** `model.py`, `schedule.py`, croniter, reducer upgrade,
   migration and backfill, API, clock on `routine_next_run_at`, web contract
   adaptation, docs (`api.md`, the CLAUDE.md automations invariant, a
   superseded note on `automation-triggers-design.md`).
3. **Auto-pause on failure,** the resume route, and the banner.
