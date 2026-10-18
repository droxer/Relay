# Automations v2 Implementation Plan

**Goal:** Ship the v2 automation trigger model (multi-trigger, time-of-day/cron schedules, one state field, auto-pause) behind one `relay/automations/` seam, with every trigger firing through one path.

**Architecture:** PR 1 moves existing logic into `backend/relay/automations/` with no behavior change. PR 2 adds the v2 model: pure `model.py` + `schedule.py`, a reducer that upgrades legacy fields on replay, new materialized columns, a clock that marks schedules pending instead of promoting directly, and the API/web contract. PR 3 adds auto-pause on repeated failure and the resume route.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy / Alembic / pytest; `croniter` (new); TypeScript / Next.js web with `node:test`-style tests run by vitest.

**Spec:** `docs/automation-v2-design.md`

> Note (2026-10-18): the file-backed `LocalTaskStore` this plan mentions has since been retired; tasks and sessions are database-only, and tests build them on sqlite through `backend/tests/store_fixtures.py`.

## Global Constraints

- Wire, storage, and event names keep `routine*`; product copy says Automations.
- `routineTriggers`: 0..5 triggers, OR-ed; at most one `webhook`; `[]` means Run-now only.
- Cron schedules: 5-field, no gap under **15 minutes** across the next 50 fires.
- `timezone: null` resolves to `RELAY_TASK_SCHEDULER_TIMEZONE`, else server local.
- `routineState ∈ {active, paused, paused_by_relay}`; `routinePauseReason ∈ {rate_limited, failing, no_target, invalid_schedule}`, only with `paused_by_relay`.
- Rate cap: `RELAY_AUTOMATION_MAX_RUNS_PER_HOUR` (default 6) counts event, webhook, and Run-now fires; **schedule fires are exempt**.
- Auto-pause threshold: **3** consecutive failed occurrences.
- Loop guards unchanged: self-origin, own occurrence, depth > 3.
- The backend never executes agents; occurrences dispatch through the existing daemon path.
- Event log is authoritative; materialized columns are written only by `task_to_row`.
- Every new user-facing string lands in `en` **and** `zh-CN`.
- Commit messages: conventional commits (`feat:`, `fix:`, `refactor:`, `test:`, `docs:`).

## Deviations from the spec (decided while planning)

1. **No `promote_occurrence` rename.** `create_triggered_occurrence(routine_id, *, run_date, trigger_kind, depth, context, summary)` already is the single stamped-promotion primitive; it stays and `promote_due_routine` is deleted.
2. **`routineNextRunAt` for legacy routines is seeded by the clock, not the migration.** The reducer must stay pure, so it cannot resolve "D 00:00 in the server timezone" during replay. The clock's *seed* step gives every active schedule automation without a `routineNextRunAt` one — from its legacy `routineNextRunDate` (00:00 server zone) or else the next fire after now. This also covers resume. The migration backfills only `routine_state`, `routine_listens`, and `routine_has_schedule`.
3. **New materialized columns `routine_listens` and `routine_has_schedule`** (any non-schedule trigger / any schedule trigger) replace the single-valued `routine_trigger_kind` filters.
4. **Dead code removed in PR 1:** `task_routes.start_routine_occurrence_on_ready_node`, `task_dispatch.dispatch_routine_occurrence` / `_prepare_routine_occurrence` / `_create_manual_occurrence`, and the stores' `create_routine_occurrence` have no production callers.
5. **A legacy routine with no next run date** ("unscheduled") upgrades to `routineTriggers: []`.

## Review Focus

1. **A schedule saved at a nonexistent DST time** (02:30 on spring-forward day) fires once that day at the first valid instant, and never twice on fall-back day — pinned in Task 6.
2. **An automation paused while events are pending** must not fire on resume from stale pending state — resume clears pending and recomputes next run; pinned in Task 15.
3. **A legacy routine edited by the new web build** (GET returns upgraded v2 fields; PATCH sends them back) saves cleanly and keeps its schedule — pinned in Task 12 (`test_patch_legacy_routine_with_v2_fields_keeps_schedule`).
4. **Two identical triggers on one automation** fire once per event, not twice — pinned in Task 11 (`test_duplicate_triggers_mark_pending_once`).
5. **Run now on an automation with no target** answers with a pause reason instead of queueing forever — pinned in Task 11 (`test_run_now_without_target_pauses`).

## File map

| File | Responsibility |
|---|---|
| `backend/relay/automations/model.py` (from `trigger.py`) | Pure trigger/state normalization, matching, legacy upgrade |
| `backend/relay/automations/context.py` (from `trigger.py`) | Trigger context block text |
| `backend/relay/automations/schedule.py` (new) | Preset → cron compile, `next_fire_after`, floor, summary, timezone resolve |
| `backend/relay/automations/clock.py` (new) | Seed + due-schedule step |
| `backend/relay/automations/firing.py` (from `matcher.py`) | Pending → coalesce / cap / no-target / pause → promote |
| `backend/relay/automations/matcher.py` | Outbox drain and match |
| `backend/relay/automations/service.py` (new) | `AutomationService`: tick, field validation, run now, resume |
| `backend/relay/api/automation_routes.py` | Automation HTTP handlers (webhook, secret, preview, resume) |
| `backend/relay/persistence/store_common.py` | Reducer `_apply_task_routine_fields` |
| `backend/relay/persistence/task_store.py` | Columns, `task_to_row`, routine queries |
| `backend/relay/persistence/automation_store.py` | `mark_pending`, `consecutive_failures` |
| `backend/migrations/versions/20261013_0091_automation_v2.py` (new) | Columns, indexes, backfill |
| `backend/relay/tasks/scheduler.py` | Dispatch only; calls `AutomationService.tick` |
| `packages/relay-core/src/task-store.ts` | Shared task types (web imports these via `relay-core`) |
| `web/src/lib/automationTrigger.ts`, `automationSchedule.ts` (new), `routine.ts`, `taskBoardForm.ts` | Web mirror and form state |
| `web/src/components/task-board/AutomationTriggerFields.tsx`, `ScheduleFields.tsx` (new), `AutomationPauseBanner.tsx` (new), `TaskDrawer.tsx`, `RoutineRecords.tsx`, `RoutineChrome.tsx` | Web UI |

Backend tests: `cd backend && uv run pytest <path> -q`. Web tests: `cd web && npx vitest run <path>`.

---

# PR 1 — Restructure, no behavior change

Branch `mc/automation-v2-restructure`. **Every task leaves the existing suite passing**; test edits are limited to import paths and deleting tests of the dead path (Task 1).

### Task 1: Delete the dead routine-dispatch path

**Files:**
- Modify: `backend/relay/api/task_routes.py` (remove `start_routine_occurrence_on_ready_node` ~line 397 and the import alias at line 44)
- Modify: `backend/relay/services/task_dispatch.py` (remove `dispatch_routine_occurrence`, `_prepare_routine_occurrence`, `_create_manual_occurrence`, and `routine_next_run_date` if unused afterward)
- Modify: `backend/relay/persistence/task_store.py` (remove `create_routine_occurrence` from both stores; `_open_routine_occurrence` if unused)
- Modify: `backend/relay/persistence/protocols.py` (drop removed methods)

**Interfaces:**
- Produces: nothing new. Surviving occurrence primitives: `promote_due_routine` (removed in Task 10) and `create_triggered_occurrence`.

- [ ] **Step 1: Prove it is dead**

Run: `cd backend && grep -rn "start_routine_occurrence_on_ready_node\|dispatch_routine_occurrence\|_prepare_routine_occurrence\|_create_manual_occurrence\|create_routine_occurrence\b" relay tests`
Expected: only definitions, the `task_routes` import alias, and tests calling them directly. If any production caller exists, **stop and report** — the code is not dead.

- [ ] **Step 2: Delete** the functions and now-unused imports. A test that only exercised a removed function is deleted; a test that used one as setup for something else switches to `create_triggered_occurrence(routine_id, run_date=..., trigger_kind="manual", depth=0, context="")`.

- [ ] **Step 3: Run the suite** — `cd backend && uv run pytest -q` → PASS.

- [ ] **Step 4: Commit**

```bash
git add -A backend
git commit -m "refactor: remove the unused routine occurrence dispatch path"
```

### Task 2: Split `trigger.py` into `model.py` and `context.py`

**Files:**
- Create (via `git mv`): `backend/relay/automations/model.py` — everything in `trigger.py` except the context block
- Create: `backend/relay/automations/context.py` — `trigger_context_block`, `_event_line`, `EVENT_LABELS`, `WEBHOOK_PAYLOAD_LIMIT`
- Modify: every importer (`grep -rln "automations.trigger\|from .trigger import" backend`)
- Rename: `backend/tests/unit/test_automation_trigger.py` → `test_automation_model.py`

**Interfaces:**
- Produces: `relay.automations.model` exports `TRIGGER_KINDS, EVENT_KINDS, TRIGGER_ON, EVENT_TYPES, SCHEDULE_TRIGGER, SCOPE_FILTERS, FILTER_KEYS, TASK_STATUSES, TASK_PRIORITIES, TITLE_CONTAINS_MAX, ID_MAX, TriggerError, normalize_trigger, trigger_of, trigger_kind, event_matches`. `relay.automations.context` exports `EVENT_LABELS, WEBHOOK_PAYLOAD_LIMIT, trigger_context_block`.

- [ ] **Step 1: Move code.** `git mv backend/relay/automations/trigger.py backend/relay/automations/model.py`; cut the context functions into `context.py` (it needs `import json`, `from typing import Any`). Docstrings: model = "what starts an automation"; context = "the block appended to an occurrence's description — `web/src/lib/automationOpening.ts` parses it, keep them in step".
- [ ] **Step 2: Fix imports.** `cd backend && grep -rln "automations.trigger\|from .trigger import" relay tests | xargs sed -i '' -e 's/automations\.trigger/automations.model/g' -e 's/from \.trigger import/from .model import/g'`, then move `trigger_context_block` / `EVENT_LABELS` imports to `.context` by hand (`grep -rn "trigger_context_block\|EVENT_LABELS" relay tests`). Also `git mv backend/tests/unit/test_automation_trigger.py backend/tests/unit/test_automation_model.py`.
- [ ] **Step 3: Run** `cd backend && uv run pytest -q` → PASS.
- [ ] **Step 4: Commit** — `git add -A backend && git commit -m "refactor: split automation trigger model from its context block"`

### Task 3: Extract `firing.py` from `matcher.py`

**Files:**
- Create: `backend/relay/automations/firing.py`
- Modify: `backend/relay/automations/matcher.py`
- Test: `backend/tests/unit/test_automation_matcher.py` (unchanged; must still pass)

**Interfaces:**
- Produces: `class AutomationFiring(*, task_store, automation_store, today, max_runs_per_hour)` with `fire(now: datetime) -> int`. `PENDING_TTL`, `RATE_WINDOW`, `RATE_LIMITED`, `IN_FLIGHT_STATUSES`, `IN_FLIGHT_LOOKBACK`, and `in_flight_occurrence(task_store, routine)` move to `firing.py`; `matcher.py` re-imports `in_flight_occurrence` so `task_routes.py` keeps working until Task 5.
- `AutomationMatcher.__init__` signature unchanged; it builds `self.firing = AutomationFiring(task_store=task_store, automation_store=automation_store, today=today, max_runs_per_hour=max_runs_per_hour)`. `run()` becomes:

```python
    def run(self) -> int:
        now = self._now()
        with store_transaction(self.automation_store.engine) as conn:
            if conn.dialect.name == "postgresql" and not conn.scalar(
                text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY}
            ):
                return 0
            self._drain(now)
            return self.firing.fire(now)
```

- [ ] **Step 1: Move** `_fire` → `AutomationFiring.fire`, `_fire_one` verbatim, and a copy of `_load` (the matcher's `_targets` still needs its own).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_matcher.py tests/api/test_automation_triggers_api.py tests/api/test_automation_webhook.py -q` → PASS.
- [ ] **Step 3: Commit** — `git add -A backend && git commit -m "refactor: separate automation firing from outbox matching"`

### Task 4: Extract the schedule clock; add `AutomationService.tick`

**Files:**
- Create: `backend/relay/automations/clock.py`, `backend/relay/automations/service.py`
- Modify: `backend/relay/tasks/scheduler.py` — remove `_promote_due_routines`, `_record_routine_skip`, `_routine_due`, `_due_routines`, `next_routine_date`, `_add_interval`, `_add_month`, `_month_days`, `ROUTINE_SKIP_NO_AGENT_MESSAGE`; replace the `automation_matcher` parameter with `automations`
- Modify: `backend/relay/tasks/__init__.py` — re-export `next_routine_date` from `relay.automations.clock` (matcher and `task_routes` still import it)
- Modify: `backend/relay/app.py` — `task_scheduler_from_env` builds the service
- Test: `backend/tests/unit/test_task_scheduler.py` (import paths only)

**Interfaces:**
- Produces:

```python
# clock.py
ROUTINE_SKIP_NO_AGENT_MESSAGE = ...                              # moved verbatim
def next_routine_date(run_date: date, cadence: str, today: date) -> date | None   # moved verbatim
class ScheduleClock:
    def __init__(self, *, task_store: Any, project_store: Any,
                 materialize_assignment: Callable[[dict[str, Any]], dict[str, Any] | None]) -> None: ...
    def run(self, today: date) -> tuple[int, int]                 # (promoted, skipped) — body of _promote_due_routines

# service.py
class AutomationService:
    def __init__(self, *, matcher: AutomationMatcher | None, clock: ScheduleClock) -> None: ...
    def tick(self, today: date) -> tuple[int, int, int]           # (fired, promoted, skipped)
```

- `tick` calls `matcher.run()` (exception → `logger.exception("Automation matching failed")`, counts 0 — today's `_fire_automations` behavior), then `clock.run(today)`.
- `TaskScheduler.__init__(..., automations: AutomationService | None = None, ...)`. If `automations` is None it builds `AutomationService(matcher=None, clock=ScheduleClock(task_store=..., project_store=..., materialize_assignment=self._materialize_legacy_assignment))`, so the `LocalTaskStore` scheduler tests keep promoting. `_tick_sync`:

```python
    def _tick_sync(self, loop: asyncio.AbstractEventLoop) -> SchedulerTickResult:
        with compact_task_writes():
            fired, promoted, promote_skipped = self.automations.tick(self._today())
            dispatched, dispatch_skipped = self._dispatch_assigned_tasks(loop)
            return SchedulerTickResult(fired=fired, promoted=promoted, dispatched=dispatched,
                                       skipped=promote_skipped + dispatch_skipped)
```

- [ ] **Step 1: Move code verbatim** and rewire as above; `_materialize_legacy_assignment` stays on `TaskScheduler` (dispatch uses it too).
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_task_scheduler.py tests/unit/test_automation_matcher.py -q` → PASS; then `uv run pytest -q` → PASS.
- [ ] **Step 3: Commit** — `git add -A backend && git commit -m "refactor: move routine promotion into the automations package"`

### Task 5: Move Run now and routine validation into the service

**Files:**
- Modify: `backend/relay/automations/service.py` — add `routine_fields` (moved from `task_routes.py:256`), `validate_trigger_scope` (moved), `request_manual_occurrence` + `_active_occurrence_result` (moved from `_request_manual_occurrence`)
- Modify: `backend/relay/api/task_routes.py` — import them; `start_task` keeps path `POST /tasks/{task_id}/runs` and its responses
- Modify: `backend/relay/automations/matcher.py` — drop the `in_flight_occurrence` re-import once `task_routes`/service import it from `firing`

**Interfaces:**
- Produces module functions in `relay.automations.service`: `routine_fields(body, *, current=None, calendar_date=None) -> dict`, `validate_trigger_scope(ctx, trigger, *, owner) -> None`, `request_manual_occurrence(automation_store, ctx, task, actor) -> dict` (takes the store instead of `Request`). They still raise `HTTPException`, as today — PR 2 replaces `routine_fields`.

- [ ] **Step 1: Move** the functions; `start_task` passes `request.app.state.automation_store`.
- [ ] **Step 2: Run** `cd backend && uv run pytest tests/api -q` → PASS.
- [ ] **Step 3: Check shrinkage** — `wc -l backend/relay/api/task_routes.py backend/relay/tasks/scheduler.py` — expect task_routes ≥150 lines and scheduler ≥100 lines smaller than at `main`.
- [ ] **Step 4: Commit** — `git add -A backend && git commit -m "refactor: route automation validation and Run now through the automations seam"`
- [ ] **Step 5: Open PR 1** — title `refactor: gather automation logic into relay/automations`; body: no behavior change, the list of moves, the dead code removed.

---

# PR 2 — The v2 model

Branch `mc/automation-v2-model`, based on PR 1.

### Task 6: `schedule.py` — presets, cron, timezone, next fire

**Files:**
- Modify: `backend/pyproject.toml` — add `"croniter>=6.0.0",` to `dependencies`; run `cd backend && uv lock`
- Create: `backend/relay/automations/schedule.py`
- Test: `backend/tests/unit/test_automation_schedule.py`

**Interfaces:**
- Produces:

```python
class ScheduleError(ValueError): ...
CRON_FLOOR = timedelta(minutes=15)
def normalize_schedule(raw: Any) -> dict[str, Any]          # canonical {"timezone", "repeat"}; raises ScheduleError naming the field
def to_cron(repeat: dict[str, Any]) -> str | None           # None for "once"
def resolve_timezone(name: str | None) -> tzinfo
def next_fire_after(schedule: dict[str, Any], after: datetime) -> datetime | None   # aware UTC, strictly > after
def next_fires(schedule: dict[str, Any], after: datetime, count: int) -> list[datetime]
def summarize(schedule: dict[str, Any]) -> str              # English, e.g. "Weekdays at 09:00 (Asia/Shanghai)"
```

- [ ] **Step 1: Write the failing tests**

```python
from datetime import datetime, timezone

import pytest
from relay.automations.schedule import ScheduleError, next_fire_after, next_fires, normalize_schedule, summarize, to_cron

UTC = timezone.utc


def sched(repeat, tz="UTC"):
    return normalize_schedule({"timezone": tz, "repeat": repeat})


@pytest.mark.parametrize("repeat, cron", [
    ({"every": "hour", "minute": 5}, "5 * * * *"),
    ({"every": "day", "at": "09:30"}, "30 9 * * *"),
    ({"every": "weekday", "at": "08:00"}, "0 8 * * 1-5"),
    ({"every": "week", "at": "07:15", "days": [1, 3, 7]}, "15 7 * * 1,3,0"),
    ({"every": "month", "at": "06:00", "day": 15}, "0 6 15 * *"),
    ({"cron": "*/30 * * * *"}, "*/30 * * * *"),
])
def test_presets_compile(repeat, cron):
    assert to_cron(sched(repeat)["repeat"]) == cron


def test_next_fire_is_strictly_after():
    s = sched({"every": "day", "at": "09:00"})
    assert next_fire_after(s, datetime(2026, 10, 13, 9, 0, tzinfo=UTC)) == datetime(2026, 10, 14, 9, 0, tzinfo=UTC)


def test_timezone_is_applied():
    s = sched({"every": "day", "at": "09:00"}, "Asia/Shanghai")
    assert next_fire_after(s, datetime(2026, 10, 13, 0, 0, tzinfo=UTC)) == datetime(2026, 10, 13, 1, 0, tzinfo=UTC)


def test_spring_forward_nonexistent_time_fires_once_at_first_valid_instant():
    s = sched({"every": "day", "at": "02:30"}, "America/New_York")
    fires = next_fires(s, datetime(2027, 3, 13, 12, 0, tzinfo=UTC), 2)
    # 2027-03-14 02:30 does not exist in New York; resolving with the
    # pre-transition offset (EST, -5) gives 07:30 UTC = 03:30 EDT.
    assert fires == [datetime(2027, 3, 14, 7, 30, tzinfo=UTC), datetime(2027, 3, 15, 6, 30, tzinfo=UTC)]


def test_fall_back_ambiguous_time_fires_once():
    s = sched({"every": "day", "at": "01:30"}, "Europe/London")
    fires = next_fires(s, datetime(2026, 10, 24, 12, 0, tzinfo=UTC), 2)
    # 2026-10-25 01:30 happens twice in London; fold=0 takes the BST one (00:30 UTC).
    assert fires == [datetime(2026, 10, 25, 0, 30, tzinfo=UTC), datetime(2026, 10, 26, 1, 30, tzinfo=UTC)]


def test_month_day_31_clamps_to_month_end():
    s = sched({"every": "month", "at": "00:00", "day": 31})
    assert next_fire_after(s, datetime(2026, 10, 31, 1, tzinfo=UTC)) == datetime(2026, 11, 30, 0, 0, tzinfo=UTC)


def test_once_fires_once():
    s = sched({"once": "2026-10-20T09:00"})
    first = next_fire_after(s, datetime(2026, 10, 13, tzinfo=UTC))
    assert first == datetime(2026, 10, 20, 9, 0, tzinfo=UTC)
    assert next_fire_after(s, first) is None


@pytest.mark.parametrize("raw, message", [
    ({"timezone": "Mars/Base", "repeat": {"every": "day", "at": "09:00"}}, "timezone"),
    ({"timezone": None, "repeat": {"every": "day", "at": "25:00"}}, "repeat.at"),
    ({"timezone": None, "repeat": {"every": "week", "at": "09:00", "days": []}}, "repeat.days"),
    ({"timezone": None, "repeat": {"every": "week", "at": "09:00", "days": [8]}}, "repeat.days"),
    ({"timezone": None, "repeat": {"every": "month", "at": "09:00", "day": 0}}, "repeat.day"),
    ({"timezone": None, "repeat": {"cron": "* * * * *"}}, "15 minutes"),
    ({"timezone": None, "repeat": {"cron": "0,5 * * * *"}}, "15 minutes"),
    ({"timezone": None, "repeat": {"cron": "not a cron"}}, "repeat.cron"),
    ({"timezone": None, "repeat": {"once": "tomorrow"}}, "repeat.once"),
    ({"timezone": None, "repeat": {"every": "day", "at": "09:00", "extra": 1}}, "unknown"),
])
def test_invalid_schedules_name_the_field(raw, message):
    with pytest.raises(ScheduleError, match=message):
        normalize_schedule(raw)


def test_summary():
    assert summarize(sched({"every": "weekday", "at": "09:00"}, "Asia/Shanghai")) == "Weekdays at 09:00 (Asia/Shanghai)"
    assert summarize(sched({"every": "week", "at": "09:00", "days": [1, 5]})) == "Every Mon, Fri at 09:00 (UTC)"
    assert summarize(normalize_schedule({"timezone": None, "repeat": {"cron": "0 */2 * * *"}})) == "Cron 0 */2 * * * (server time)"
```

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_schedule.py -q` → FAIL (`ModuleNotFoundError: relay.automations.schedule`).

- [ ] **Step 3: Implement `schedule.py`**

```python
"""When a schedule trigger fires.

Schedules are stored as structured presets so the web round-trips them
without parsing cron; this module compiles each to a cron expression and is
the only place Relay evaluates one. Fire times are computed in the
schedule's local wall time and then resolved to UTC, so a time that does not
exist (spring forward) fires at the first valid instant and an ambiguous one
(fall back) fires once.
"""

from __future__ import annotations

import os
import re
from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from croniter import croniter

CRON_FLOOR = timedelta(minutes=15)
FLOOR_SAMPLES = 50
EVERY = ("hour", "day", "weekday", "week", "month")
_TIME = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")
_DAY_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
_REPEAT_KEYS = {
    "hour": {"every", "minute"},
    "day": {"every", "at"},
    "weekday": {"every", "at"},
    "week": {"every", "at", "days"},
    "month": {"every", "at", "day"},
}
_FLOOR_ORIGIN = datetime(2026, 1, 1, tzinfo=timezone.utc)


class ScheduleError(ValueError):
    """A schedule the API refuses with a 400; the message names the field."""


def resolve_timezone(name: str | None) -> tzinfo:
    name = name or os.environ.get("RELAY_TASK_SCHEDULER_TIMEZONE", "").strip() or None
    if name is None:
        return datetime.now().astimezone().tzinfo or timezone.utc
    return ZoneInfo(name)


def _is_int(value: Any, low: int, high: int) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and low <= value <= high


def normalize_schedule(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict) or set(raw) - {"timezone", "repeat"}:
        raise ScheduleError("schedule must be an object with timezone and repeat (unknown keys refused).")
    zone = raw.get("timezone")
    if zone is not None:
        if not isinstance(zone, str):
            raise ScheduleError("schedule.timezone must be an IANA name or null.")
        try:
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError) as error:
            raise ScheduleError(f"schedule.timezone {zone!r} is not a known IANA timezone.") from error
    schedule = {"timezone": zone, "repeat": _normalize_repeat(raw.get("repeat"))}
    if "cron" in schedule["repeat"]:
        _check_floor(schedule)
    return schedule


def _normalize_repeat(repeat: Any) -> dict[str, Any]:
    if not isinstance(repeat, dict):
        raise ScheduleError("schedule.repeat must be an object.")
    if "cron" in repeat:
        if set(repeat) != {"cron"} or not isinstance(repeat["cron"], str):
            raise ScheduleError("schedule.repeat.cron must be a string and the only key (unknown keys refused).")
        expression = " ".join(repeat["cron"].split())
        if len(expression.split(" ")) != 5 or not croniter.is_valid(expression):
            raise ScheduleError("schedule.repeat.cron must be a valid 5-field cron expression.")
        return {"cron": expression}
    if "once" in repeat:
        if set(repeat) != {"once"}:
            raise ScheduleError("schedule.repeat.once takes no other keys (unknown keys refused).")
        try:
            moment = datetime.strptime(str(repeat["once"]), "%Y-%m-%dT%H:%M")
        except ValueError as error:
            raise ScheduleError("schedule.repeat.once must be YYYY-MM-DDTHH:MM.") from error
        return {"once": moment.strftime("%Y-%m-%dT%H:%M")}
    every = repeat.get("every")
    if every not in EVERY:
        raise ScheduleError(f"schedule.repeat.every must be one of: {', '.join(EVERY)}.")
    if set(repeat) - _REPEAT_KEYS[every]:
        raise ScheduleError(f"schedule.repeat has unknown keys for every={every}.")
    if every == "hour":
        if not _is_int(repeat.get("minute"), 0, 59):
            raise ScheduleError("schedule.repeat.minute must be 0–59.")
        return {"every": "hour", "minute": repeat["minute"]}
    at = repeat.get("at")
    if not isinstance(at, str) or not _TIME.match(at):
        raise ScheduleError("schedule.repeat.at must be HH:MM (24-hour).")
    out: dict[str, Any] = {"every": every, "at": at}
    if every == "week":
        days = repeat.get("days")
        if not isinstance(days, list) or not days or not all(_is_int(d, 1, 7) for d in days):
            raise ScheduleError("schedule.repeat.days must be a non-empty list of ISO weekdays 1–7.")
        out["days"] = sorted(set(days))
    if every == "month":
        if not _is_int(repeat.get("day"), 1, 31):
            raise ScheduleError("schedule.repeat.day must be 1–31.")
        out["day"] = repeat["day"]
    return out


def to_cron(repeat: dict[str, Any]) -> str | None:
    if "cron" in repeat:
        return repeat["cron"]
    if "once" in repeat:
        return None
    if repeat["every"] == "hour":
        return f"{repeat['minute']} * * * *"
    hour, minute = (int(part) for part in repeat["at"].split(":"))
    if repeat["every"] == "day":
        return f"{minute} {hour} * * *"
    if repeat["every"] == "weekday":
        return f"{minute} {hour} * * 1-5"
    if repeat["every"] == "week":
        return f"{minute} {hour} * * " + ",".join(str(day % 7) for day in repeat["days"])
    return f"{minute} {hour} {repeat['day']} * *"


def _resolve(local: datetime, zone: tzinfo) -> datetime:
    """Local wall time → UTC. fold=0 takes the first of an ambiguous pair; a
    nonexistent time keeps the pre-transition offset, which lands on the
    first valid instant after the gap."""
    return local.replace(tzinfo=zone, fold=0).astimezone(timezone.utc)


def next_fire_after(schedule: dict[str, Any], after: datetime) -> datetime | None:
    zone = resolve_timezone(schedule.get("timezone"))
    repeat = schedule["repeat"]
    if "once" in repeat:
        moment = _resolve(datetime.strptime(repeat["once"], "%Y-%m-%dT%H:%M"), zone)
        return moment if moment > after else None
    if repeat.get("every") == "month" and repeat["day"] > 28:
        return _next_clamped_month_day(repeat, after, zone)
    iterator = croniter(to_cron(repeat), after.astimezone(zone).replace(tzinfo=None))
    # Iterating in naive local time can step back across a fall-back hour;
    # skip candidates that are not strictly later in real time.
    for _ in range(FLOOR_SAMPLES):
        candidate = _resolve(iterator.get_next(datetime), zone)
        if candidate > after:
            return candidate
    return None


def _next_clamped_month_day(repeat: dict[str, Any], after: datetime, zone: tzinfo) -> datetime:
    hour, minute = (int(part) for part in repeat["at"].split(":"))
    local = after.astimezone(zone)
    year, month = local.year, local.month
    for _ in range(3):
        following = datetime(year + (month == 12), 1 if month == 12 else month + 1, 1)
        last_day = (following - timedelta(days=1)).day
        candidate = _resolve(datetime(year, month, min(repeat["day"], last_day), hour, minute), zone)
        if candidate > after:
            return candidate
        year, month = following.year, following.month
    raise AssertionError("a month-day schedule always fires within three months")


def next_fires(schedule: dict[str, Any], after: datetime, count: int) -> list[datetime]:
    fires: list[datetime] = []
    cursor = after
    while len(fires) < count:
        following = next_fire_after(schedule, cursor)
        if following is None:
            break
        fires.append(following)
        cursor = following
    return fires


def _check_floor(schedule: dict[str, Any]) -> None:
    fires = next_fires(schedule, _FLOOR_ORIGIN, FLOOR_SAMPLES)
    if any(later - earlier < CRON_FLOOR for earlier, later in zip(fires, fires[1:])):
        raise ScheduleError("schedule.repeat.cron must not fire more often than every 15 minutes.")


def summarize(schedule: dict[str, Any]) -> str:
    repeat = schedule["repeat"]
    if "cron" in repeat:
        text = f"Cron {repeat['cron']}"
    elif "once" in repeat:
        text = f"Once at {repeat['once'].replace('T', ' ')}"
    elif repeat["every"] == "hour":
        text = f"Hourly at :{repeat['minute']:02d}"
    elif repeat["every"] == "day":
        text = f"Daily at {repeat['at']}"
    elif repeat["every"] == "weekday":
        text = f"Weekdays at {repeat['at']}"
    elif repeat["every"] == "week":
        text = f"Every {', '.join(_DAY_NAMES[day] for day in repeat['days'])} at {repeat['at']}"
    else:
        text = f"Monthly on day {repeat['day']} at {repeat['at']}"
    return f"{text} ({schedule.get('timezone') or 'server time'})"
```

- [ ] **Step 4: Run** `cd backend && uv run pytest tests/unit/test_automation_schedule.py -q` → PASS. If a DST expectation fails, print the actual fires, check them against the tz database by hand (`python -c "from zoneinfo import ZoneInfo; ..."`), and fix `_resolve` or the iteration — do not weaken the test to match buggy output.

- [ ] **Step 5: Commit**

```bash
git add backend/pyproject.toml backend/uv.lock backend/relay/automations/schedule.py backend/tests/unit/test_automation_schedule.py
git commit -m "feat: evaluate automation schedules with presets, cron, and timezones"
```

### Task 7: `model.py` v2 — trigger lists, state, legacy upgrade

**Files:**
- Modify: `backend/relay/automations/model.py`
- Test: `backend/tests/unit/test_automation_model.py`

**Interfaces:**
- Consumes: `normalize_schedule`, `ScheduleError` (Task 6).
- Produces:

```python
TRIGGER_KINDS = ("schedule", "task_event", "run_event", "webhook")   # "manual" removed
MAX_TRIGGERS = 5
STATES = ("active", "paused", "paused_by_relay")
PAUSE_REASONS = ("rate_limited", "failing", "no_target", "invalid_schedule")
LEGACY_FIELDS = ("routineType", "routineCadence", "routineNextRunDate", "routineEnabled", "routineDisabledReason", "routineTrigger")
def normalize_triggers(raw: Any) -> list[dict[str, Any]]      # raises TriggerError("routineTriggers[i]. ...")
def triggers_of(task: dict[str, Any]) -> list[dict[str, Any]] # [] when absent
def schedule_triggers(task: dict[str, Any]) -> list[dict[str, Any]]
def listens(task: dict[str, Any]) -> bool                     # any non-schedule trigger
def has_webhook(task: dict[str, Any]) -> bool
def state_of(task: dict[str, Any]) -> str                     # "paused" when absent/unknown
def is_active(task: dict[str, Any]) -> bool
def upgrade_legacy(legacy: dict[str, Any]) -> dict[str, Any]  # {"routineTriggers", "routineState", "routinePauseReason"?}
```

`normalize_trigger` (single, event/webhook) stays as the per-item validator. `trigger_of` / `trigger_kind` / `SCHEDULE_TRIGGER` stay until Task 12 deletes their last caller.

- [ ] **Step 1: Write the failing tests** (append to `test_automation_model.py`; the existing `normalize_trigger` tests that use `kind: "manual"` change to expect a `TriggerError`)

```python
import pytest
from relay.automations.model import TriggerError, listens, normalize_triggers, state_of, upgrade_legacy

DAILY = {"kind": "schedule", "schedule": {"timezone": None, "repeat": {"every": "day", "at": "09:00"}}}
BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def test_normalize_list_round_trips():
    assert normalize_triggers([DAILY, BLOCKED, {"kind": "webhook"}]) == [DAILY, BLOCKED, {"kind": "webhook"}]


def test_empty_list_is_run_now_only():
    assert normalize_triggers([]) == []


@pytest.mark.parametrize("raw, message", [
    ("nope", "routineTriggers must be a list"),
    ([DAILY] * 6, "at most 5"),
    ([{"kind": "webhook"}, {"kind": "webhook"}], "one webhook"),
    ([{"kind": "manual"}], r"routineTriggers\[0\]\.kind"),
    ([DAILY, {"kind": "schedule", "schedule": {"timezone": None, "repeat": {"cron": "* * * * *"}}}],
     r"routineTriggers\[1\]\..*15 minutes"),
    ([{"kind": "schedule"}], r"routineTriggers\[0\]\.schedule"),
])
def test_invalid_lists_name_the_index(raw, message):
    with pytest.raises(TriggerError, match=message):
        normalize_triggers(raw)


def _schedule(repeat):
    return [{"kind": "schedule", "schedule": {"timezone": None, "repeat": repeat}}]


@pytest.mark.parametrize("legacy, triggers", [
    ({"routineCadence": "daily", "routineNextRunDate": "2026-10-14"}, _schedule({"every": "day", "at": "00:00"})),
    ({"routineCadence": "weekly", "routineNextRunDate": "2026-10-14"},  # a Wednesday
     _schedule({"every": "week", "at": "00:00", "days": [3]})),
    ({"routineCadence": "monthly", "routineNextRunDate": "2026-10-31"},
     _schedule({"every": "month", "at": "00:00", "day": 31})),
    ({"routineCadence": "custom", "routineNextRunDate": "2026-10-20"}, _schedule({"once": "2026-10-20T00:00"})),
    ({"routineCadence": "custom"}, []),
    ({"routineCadence": "weekly"}, []),  # unscheduled
    ({"routineTrigger": {"kind": "manual"}, "routineCadence": "weekly", "routineNextRunDate": "2026-10-14"}, []),
    ({"routineTrigger": BLOCKED}, [BLOCKED]),
    ({"routineTrigger": {"kind": "webhook"}}, [{"kind": "webhook"}]),
])
def test_upgrade_legacy_triggers(legacy, triggers):
    assert upgrade_legacy(legacy)["routineTriggers"] == triggers


@pytest.mark.parametrize("legacy, state, reason", [
    ({"routineEnabled": True}, "active", None),
    ({"routineEnabled": False}, "paused", None),
    ({}, "paused", None),
    ({"routineEnabled": False, "routineDisabledReason": "rate_limited"}, "paused_by_relay", "rate_limited"),
])
def test_upgrade_legacy_state(legacy, state, reason):
    upgraded = upgrade_legacy(legacy)
    assert upgraded["routineState"] == state
    assert upgraded.get("routinePauseReason") == reason


def test_listens_and_state_defaults():
    assert listens({"routineTriggers": [DAILY]}) is False
    assert listens({"routineTriggers": [DAILY, BLOCKED]}) is True
    assert state_of({}) == "paused"
```

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_model.py -q` → FAIL (`ImportError`).

- [ ] **Step 3: Implement.** Set `TRIGGER_KINDS = ("schedule", "task_event", "run_event", "webhook")` (the non-event branch of `normalize_trigger` now only accepts `webhook`). Add:

```python
from datetime import date

from .schedule import ScheduleError, normalize_schedule

MAX_TRIGGERS = 5
STATES = ("active", "paused", "paused_by_relay")
PAUSE_REASONS = ("rate_limited", "failing", "no_target", "invalid_schedule")
LEGACY_FIELDS = ("routineType", "routineCadence", "routineNextRunDate", "routineEnabled",
                 "routineDisabledReason", "routineTrigger")


def normalize_triggers(raw: Any) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        raise TriggerError("routineTriggers must be a list.")
    if len(raw) > MAX_TRIGGERS:
        raise TriggerError(f"routineTriggers may hold at most {MAX_TRIGGERS} triggers.")
    triggers = []
    for index, item in enumerate(raw):
        try:
            triggers.append(_normalize_one(item))
        except (TriggerError, ScheduleError) as error:
            detail = str(error).removeprefix("routineTrigger.").removeprefix("routineTrigger ")
            raise TriggerError(f"routineTriggers[{index}].{detail}") from error
    if sum(1 for trigger in triggers if trigger["kind"] == "webhook") > 1:
        raise TriggerError("routineTriggers may hold only one webhook trigger.")
    return triggers


def _normalize_one(item: Any) -> dict[str, Any]:
    if not isinstance(item, dict) or item.get("kind") not in TRIGGER_KINDS:
        raise TriggerError(f"kind must be one of: {', '.join(TRIGGER_KINDS)}.")
    if item["kind"] != "schedule":
        return normalize_trigger(item)
    if "schedule" not in item or set(item) - {"kind", "schedule"}:
        raise TriggerError("schedule is required and is the only other key of a schedule trigger.")
    return {"kind": "schedule", "schedule": normalize_schedule(item["schedule"])}


def triggers_of(task: dict[str, Any]) -> list[dict[str, Any]]:
    triggers = task.get("routineTriggers")
    return [trigger for trigger in triggers if isinstance(trigger, dict)] if isinstance(triggers, list) else []


def schedule_triggers(task: dict[str, Any]) -> list[dict[str, Any]]:
    return [trigger for trigger in triggers_of(task) if trigger.get("kind") == "schedule"]


def listens(task: dict[str, Any]) -> bool:
    return any(trigger.get("kind") != "schedule" for trigger in triggers_of(task))


def has_webhook(task: dict[str, Any]) -> bool:
    return any(trigger.get("kind") == "webhook" for trigger in triggers_of(task))


def state_of(task: dict[str, Any]) -> str:
    state = task.get("routineState")
    return state if state in STATES else "paused"


def is_active(task: dict[str, Any]) -> bool:
    return bool(task.get("isRoutine")) and state_of(task) == "active" and not task.get("deletedAt")


def upgrade_legacy(legacy: dict[str, Any]) -> dict[str, Any]:
    """What a legacy routine's fields mean in v2. Pure: the server timezone
    stays ``timezone: None`` and is resolved only when a schedule is evaluated."""
    trigger = legacy.get("routineTrigger") if isinstance(legacy.get("routineTrigger"), dict) else {"kind": "schedule"}
    if trigger.get("kind") == "schedule":
        triggers = _legacy_schedule(legacy.get("routineCadence") or "weekly", legacy.get("routineNextRunDate"))
    elif trigger.get("kind") == "manual":
        triggers = []
    else:
        triggers = [{key: value for key, value in trigger.items() if key in ("kind", "on", "filters")}]
    if legacy.get("routineEnabled"):
        state: dict[str, Any] = {"routineState": "active"}
    elif legacy.get("routineDisabledReason") == "rate_limited":
        state = {"routineState": "paused_by_relay", "routinePauseReason": "rate_limited"}
    else:
        state = {"routineState": "paused"}
    return {"routineTriggers": triggers, **state}


def _legacy_schedule(cadence: str, next_run: Any) -> list[dict[str, Any]]:
    try:
        day = date.fromisoformat(next_run) if next_run else None
    except (TypeError, ValueError):
        day = None
    if day is None:
        return []
    if cadence == "custom":
        repeat: dict[str, Any] = {"once": f"{day.isoformat()}T00:00"}
    elif cadence == "daily":
        repeat = {"every": "day", "at": "00:00"}
    elif cadence == "monthly":
        repeat = {"every": "month", "at": "00:00", "day": day.day}
    else:
        repeat = {"every": "week", "at": "00:00", "days": [day.isoweekday()]}
    return [{"kind": "schedule", "schedule": {"timezone": None, "repeat": repeat}}]
```

- [ ] **Step 4: Run** `cd backend && uv run pytest tests/unit/test_automation_model.py -q` → PASS. Then `uv run pytest -q`; tests that still create `kind: "manual"` triggers will fail — list them in the commit body; Tasks 11–12 rewrite them.
- [ ] **Step 5: Commit** — `git commit -am "feat: model automation trigger lists, state, and the legacy upgrade"`

### Task 8: Reducer — apply v2 fields, upgrade legacy events on replay

**Files:**
- Modify: `backend/relay/persistence/store_common.py` (`_apply_task_routine_fields` ~line 870; check that the `task.created` path ~line 657 calls it and stop writing `routineEnabled` there)
- Modify: the task API serializer — strip `_`-prefixed snapshot keys (find with `grep -rn "def task_response\|def public_task\|def task_view" backend/relay`; if none, add `public_task(task)` to `backend/relay/api/helpers.py` and use it in every `task_routes`/`automation_routes` response)
- Test: `backend/tests/unit/test_automation_replay.py` (new)

**Interfaces:**
- Consumes: `upgrade_legacy`, `LEGACY_FIELDS`, `STATES` (Task 7). Import them inside the function if a module-level import cycles.
- Produces snapshot keys: `routineTriggers`, `routineState`, `routinePauseReason?`, `routineNextRunAt?`. Legacy routines additionally keep `routineNextRunDate` (read by the clock seed, Task 10) and a private `_legacyRoutine` accumulator. A snapshot never again carries `routineEnabled`, `routineType`, `routineCadence`, `routineTrigger`, or `routineDisabledReason`.

- [ ] **Step 1: Write the failing tests.** First check the event shape `materialize_task_events` expects: `grep -rn "materialize_task_events(" backend/tests | head -3`, and mirror an existing call's required keys in `ev`.

```python
from relay.persistence.store_common import materialize_task_events


def ev(kind, n, **payload):
    return {"id": f"e{n}", "type": kind, "taskId": "t1", "timestamp": f"2026-10-13T00:00:0{n}Z", **payload}


def created(**fields):
    return ev("task.created", 0, title="Digest", description="", isRoutine=True, **fields)


def test_legacy_stream_replays_to_v2():
    task = materialize_task_events([
        created(routineType="job", routineCadence="weekly", routineNextRunDate="2026-10-14", routineEnabled=True),
    ])
    assert task["routineTriggers"][0]["schedule"]["repeat"] == {"every": "week", "at": "00:00", "days": [3]}
    assert task["routineState"] == "active"
    assert task["routineNextRunDate"] == "2026-10-14"
    for key in ("routineType", "routineCadence", "routineEnabled", "routineTrigger", "routineDisabledReason"):
        assert key not in task


def test_legacy_update_after_legacy_create_recomputes():
    task = materialize_task_events([
        created(routineCadence="weekly", routineNextRunDate="2026-10-14", routineEnabled=True),
        ev("task.updated", 1, routineEnabled=False, routineDisabledReason="rate_limited"),
    ])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "rate_limited")
    assert task["routineTriggers"][0]["kind"] == "schedule"
    assert "routineNextRunDate" not in task  # paused: nothing to seed


def test_v2_event_replaces_legacy_and_drops_retained_date():
    task = materialize_task_events([
        created(routineCadence="daily", routineNextRunDate="2026-10-14", routineEnabled=True),
        ev("task.updated", 1, routineTriggers=[{"kind": "webhook"}], routineState="paused", routineNextRunAt=None),
    ])
    assert task["routineTriggers"] == [{"kind": "webhook"}] and task["routineState"] == "paused"
    assert "routineNextRunDate" not in task and "routineNextRunAt" not in task and "_legacyRoutine" not in task


def test_v2_create_with_next_run():
    task = materialize_task_events([created(routineTriggers=[], routineState="active",
                                            routineNextRunAt="2026-10-14T01:00:00+00:00")])
    assert task["routineNextRunAt"] == "2026-10-14T01:00:00+00:00"


def test_resume_clears_reason():
    task = materialize_task_events([
        created(routineTriggers=[], routineState="paused_by_relay", routinePauseReason="failing"),
        ev("task.updated", 1, routineState="active"),
    ])
    assert task["routineState"] == "active" and "routinePauseReason" not in task


def test_turning_routine_off_drops_all_routine_fields():
    task = materialize_task_events([
        created(routineTriggers=[], routineState="active"),
        ev("task.updated", 1, isRoutine=False),
    ])
    stamps = {"routineTriggerKind", "routineTriggerDepth", "routineTriggerSummary"}
    assert not [key for key in task if key.startswith(("routine", "_legacy")) and key not in stamps]
```

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_replay.py -q` → FAIL.

- [ ] **Step 3: Implement** — replace `_apply_task_routine_fields`:

```python
V2_ROUTINE_FIELDS = ("routineTriggers", "routineState", "routinePauseReason", "routineNextRunAt")


def _apply_task_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    from ..automations.model import LEGACY_FIELDS

    if "isRoutine" in event and event["isRoutine"] is not None:
        task["isRoutine"] = bool(event["isRoutine"])
        if not task["isRoutine"]:
            for key in (*V2_ROUTINE_FIELDS, *LEGACY_FIELDS, "_legacyRoutine"):
                task.pop(key, None)
            return
    if not task.get("isRoutine"):
        return
    if any(key in event for key in V2_ROUTINE_FIELDS):
        _apply_v2_routine_fields(task, event)
    elif any(event.get(key) is not None for key in LEGACY_FIELDS):
        _apply_legacy_routine_fields(task, event)


def _apply_v2_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    from ..automations.model import LEGACY_FIELDS, STATES

    # A v2 write is a decision made with the upgraded fields in view; the
    # retained legacy seed no longer applies.
    for key in (*LEGACY_FIELDS, "_legacyRoutine"):
        task.pop(key, None)
    if isinstance(event.get("routineTriggers"), list):
        task["routineTriggers"] = [dict(trigger) for trigger in event["routineTriggers"]]
    if event.get("routineState") in STATES:
        task["routineState"] = event["routineState"]
        if event["routineState"] != "paused_by_relay":
            task.pop("routinePauseReason", None)
    for key in ("routinePauseReason", "routineNextRunAt"):
        if key in event:
            if event[key]:
                task[key] = event[key]
            else:
                task.pop(key, None)


def _apply_legacy_routine_fields(task: dict[str, Any], event: dict[str, Any]) -> None:
    """An old event: fold it into the retained legacy view, then re-derive v2."""
    from ..automations.model import LEGACY_FIELDS, upgrade_legacy

    legacy = dict(task.get("_legacyRoutine") or {})
    for key in LEGACY_FIELDS:
        if event.get(key) is not None:
            legacy[key] = event[key]
    if event.get("routineEnabled") is True:
        legacy.pop("routineDisabledReason", None)
    for key in ("routineDisabledReason", "routineNextRunDate"):
        if legacy.get(key) == "":
            legacy.pop(key)
    task["_legacyRoutine"] = legacy
    task.pop("routinePauseReason", None)
    task.update(upgrade_legacy(legacy))
    if legacy.get("routineEnabled") and legacy.get("routineNextRunDate"):
        task["routineNextRunDate"] = legacy["routineNextRunDate"]
    else:
        task.pop("routineNextRunDate", None)
```

Then strip `_`-prefixed keys in the API serializer and add `test_legacy_accumulator_never_reaches_the_api` to `backend/tests/api/test_tasks.py`: seed a legacy routine through the store, `GET /api/v1/tasks/{id}`, and assert `"_legacyRoutine" not in body`.

- [ ] **Step 4: Run** `cd backend && uv run pytest tests/unit/test_automation_replay.py tests/unit/test_task_store.py tests/api/test_tasks.py -q`. Replay tests PASS. Assertions in `test_task_store.py` that check legacy snapshot keys are updated to the v2 keys — list each in the commit body.
- [ ] **Step 5: Commit** — `git commit -am "feat: replay routines into the v2 automation fields"`

### Task 9: Materialized columns, migration, store queries

**Files:**
- Modify: `backend/relay/persistence/task_store.py` — columns (~line 1038), indexes (~line 1078), `task_to_row` (~line 2375), the create/update field allowlists (~lines 228 and 329: add `"routineTriggers", "routineState", "routinePauseReason", "routineNextRunAt"`), `list_trigger_automations` (both stores), new `list_due_schedules` and `list_unseeded_schedules` (both stores)
- Modify: `backend/relay/persistence/automation_store.py` — `consecutive_failures` column; `_empty_state` includes it
- Create: `backend/migrations/versions/20261013_0091_automation_v2.py`
- Test: `backend/tests/unit/test_task_store.py` (additions), `backend/tests/unit/test_automation_v2_migration.py` (new)

**Interfaces:**
- Produces on both task stores:

```python
def list_due_schedules(self, now: datetime) -> list[dict[str, Any]]   # active, routine_next_run_at <= now, oldest first
def list_unseeded_schedules(self) -> list[dict[str, Any]]             # active, has a schedule trigger, no routineNextRunAt
def list_trigger_automations(self) -> list[dict[str, Any]]            # active and listens (any non-schedule trigger)
```

- Columns: `routine_next_run_at DateTime(timezone=True) NULL`, `routine_state Text NULL`, `routine_listens Boolean NOT NULL default false`, `routine_has_schedule Boolean NOT NULL default false`; `automation_state.consecutive_failures Integer NOT NULL default 0`.
- Indexes (all partial, `active = "is_routine AND routine_state = 'active'"`): `ix_tasks_due_schedules (routine_next_run_at) WHERE active`; `ix_tasks_listening_routines (created_at) WHERE active AND routine_listens`; `ix_tasks_unseeded_schedules (created_at) WHERE active AND routine_has_schedule AND routine_next_run_at IS NULL`. The old `ix_tasks_due_routines` / `ix_tasks_triggered_routines` leave the `Table` definition and are dropped by the migration.
- `task_to_row` additions (import `state_of, listens, schedule_triggers` from `relay.automations.model`):

```python
        "routine_next_run_at": _parse_datetime(task.get("routineNextRunAt")),
        "routine_state": state_of(task) if task.get("isRoutine") else None,
        "routine_listens": listens(task) if task.get("isRoutine") else False,
        "routine_has_schedule": bool(schedule_triggers(task)) if task.get("isRoutine") else False,
        # Old replicas during a rolling deploy still read this; drop with the cleanup migration.
        "routine_enabled": bool(task.get("isRoutine")) and state_of(task) == "active",
        "routine_type": None,
        "routine_cadence": None,
        "routine_next_run_date": None,
        "routine_trigger_kind": None,
```

Use an existing datetime parser if `task_store.py` has one (`grep -n "def _parse_datetime\|def _parse_timestamp\|fromisoformat" backend/relay/persistence/task_store.py`); otherwise add beside `_parse_date`:

```python
def _parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
```

- [ ] **Step 1: Write the failing store tests** (append to `test_task_store.py`; use its existing database-store fixture — find it with `grep -n "@pytest.fixture" -A4 backend/tests/unit/test_task_store.py`, and rename `db_task_store` below to match)

```python
from datetime import datetime, timezone

DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]


def _v2_routine(store, title, **extra):
    return store.create_task({"title": title, "isRoutine": True, "routineTriggers": DAILY_9,
                              "routineState": "active", **extra})


def test_due_and_unseeded_schedule_queries(db_task_store):
    due = _v2_routine(db_task_store, "a", routineNextRunAt="2026-10-13T09:00:00+00:00")
    later = _v2_routine(db_task_store, "b", routineNextRunAt="2026-10-14T09:00:00+00:00")
    unseeded = _v2_routine(db_task_store, "c")
    _v2_routine(db_task_store, "d", routineState="paused", routineNextRunAt="2026-10-13T09:00:00+00:00")
    now = datetime(2026, 10, 13, 10, tzinfo=timezone.utc)
    assert [task["id"] for task in db_task_store.list_due_schedules(now)] == [due["id"]]
    assert [task["id"] for task in db_task_store.list_unseeded_schedules()] == [unseeded["id"]]
    assert later["id"] not in [task["id"] for task in db_task_store.list_due_schedules(now)]


def test_listening_automations_query(db_task_store):
    hook = db_task_store.create_task({"title": "h", "isRoutine": True, "routineTriggers": [{"kind": "webhook"}],
                                      "routineState": "active"})
    db_task_store.create_task({"title": "p", "isRoutine": True, "routineTriggers": [{"kind": "webhook"}],
                               "routineState": "paused"})
    _v2_routine(db_task_store, "s")
    assert [task["id"] for task in db_task_store.list_trigger_automations()] == [hook["id"]]
```

- [ ] **Step 2: Write the failing migration test** `test_automation_v2_migration.py`, copying the alembic fixture from the newest migration test (`ls -t backend/tests/unit/*_migration.py | head -1`). At revision `20261011_0090`, insert three `tasks` rows: (A) `is_routine=1, routine_enabled=1, routine_trigger_kind='webhook'`; (B) `is_routine=1, routine_enabled=0`, snapshot `{"routineDisabledReason": "rate_limited"}`; (C) `is_routine=1, routine_enabled=0, routine_trigger_kind=NULL, routine_next_run_date='2026-10-14'`. Upgrade to `20261013_0091` and assert: `routine_state` = `active`, `paused_by_relay`, `paused`; `routine_listens` = true, false, false; `routine_has_schedule` = false, false, true; `automation_state` has column `consecutive_failures`. Then downgrade to `20261011_0090` and assert the columns are gone.

- [ ] **Step 3: Run both** → FAIL.

- [ ] **Step 4: Implement** the columns, queries, `task_to_row`, and this migration:

```python
"""Automations v2: state, next-run instant, and trigger flags on tasks.

Adds the materialized columns the v2 automation model reads.
``routine_state``, ``routine_listens``, and ``routine_has_schedule`` are
backfilled from the legacy columns with the same rules as
``relay.automations.model.upgrade_legacy``. ``routine_next_run_at`` is left
NULL: the scheduler's clock seeds every active schedule automation on its
first tick, because resolving "start of day" needs the server timezone.

Revision ID: 20261013_0091
Revises: 20261011_0090
"""

import sqlalchemy as sa
from alembic import op

revision = "20261013_0091"
down_revision = "20261011_0090"
branch_labels = None
depends_on = None

ACTIVE = "is_routine AND routine_state = 'active'"


def upgrade() -> None:
    op.add_column("tasks", sa.Column("routine_next_run_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tasks", sa.Column("routine_state", sa.Text(), nullable=True))
    op.add_column("tasks", sa.Column("routine_listens", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("tasks", sa.Column("routine_has_schedule", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("automation_state",
                  sa.Column("consecutive_failures", sa.Integer(), nullable=False, server_default="0"))
    reason = ("snapshot->>'routineDisabledReason'" if op.get_bind().dialect.name == "postgresql"
              else "json_extract(snapshot, '$.routineDisabledReason')")
    op.execute(f"""
        UPDATE tasks SET
          routine_state = CASE
            WHEN routine_enabled THEN 'active'
            WHEN {reason} = 'rate_limited' THEN 'paused_by_relay'
            ELSE 'paused' END,
          routine_listens = COALESCE(routine_trigger_kind IN ('task_event', 'run_event', 'webhook'), false),
          routine_has_schedule = (routine_trigger_kind IS NULL OR routine_trigger_kind = 'schedule')
                                 AND routine_next_run_date IS NOT NULL
        WHERE is_routine
    """)
    op.drop_index("ix_tasks_due_routines", table_name="tasks", if_exists=True)
    op.drop_index("ix_tasks_triggered_routines", table_name="tasks", if_exists=True)
    for name, column, where in (
        ("ix_tasks_due_schedules", "routine_next_run_at", ACTIVE),
        ("ix_tasks_listening_routines", "created_at", f"{ACTIVE} AND routine_listens"),
        ("ix_tasks_unseeded_schedules", "created_at",
         f"{ACTIVE} AND routine_has_schedule AND routine_next_run_at IS NULL"),
    ):
        op.create_index(name, "tasks", [column], postgresql_where=sa.text(where), sqlite_where=sa.text(where))


def downgrade() -> None:
    for name in ("ix_tasks_unseeded_schedules", "ix_tasks_listening_routines", "ix_tasks_due_schedules"):
        op.drop_index(name, table_name="tasks")
    op.drop_column("automation_state", "consecutive_failures")
    for column in ("routine_has_schedule", "routine_listens", "routine_state", "routine_next_run_at"):
        op.drop_column("tasks", column)
```

Before relying on `if_exists=True`, check the Alembic version pinned in `uv.lock` supports it (≥1.12); otherwise guard with `sa.inspect(op.get_bind()).get_indexes("tasks")`. The `LocalTaskStore` gets list-comprehension versions of the three queries using `is_active`, `listens`, `schedule_triggers`, and `routineNextRunAt` (parse with `_parse_datetime`).

- [ ] **Step 5: Run** `cd backend && uv run pytest tests/unit/test_task_store.py tests/unit/test_automation_v2_migration.py -q` → PASS. If a Postgres `DATABASE_URL` is available, also run `uv run pytest -m postgres tests/unit/test_automation_v2_migration.py -q`; otherwise state in the PR that the Postgres path is unverified locally.
- [ ] **Step 6: Commit** — `git commit -am "feat: materialize automation state and next-run instant"`

### Task 10: Clock v2 — seed, due → pending, advance

**Files:**
- Modify: `backend/relay/automations/clock.py` (rewrite `ScheduleClock`; delete `next_routine_date` and `ROUTINE_SKIP_NO_AGENT_MESSAGE`)
- Modify: `backend/relay/automations/service.py` (`tick(now)`; one locked transaction around clock → drain → fire)
- Modify: `backend/relay/automations/matcher.py` (remove `run`; `_drain` → public `drain(now)`; `_mark_pending` moves to the store)
- Modify: `backend/relay/persistence/automation_store.py` (add `mark_pending(routine_id, event, now)` — the body of the matcher's `_mark_pending`, plus `MAX_PENDING_EVENTS`)
- Modify: `backend/relay/persistence/task_store.py` (delete `promote_due_routine`, `list_due_routines`, `routine_promotion_events`, `routine_due_for_promotion`, `routine_due_sort_key`, and the old `TRIGGERED_KINDS` if unused; in `routine_occurrence_events`, append the trigger context only when `trigger.get("context")` is non-empty)
- Modify: `backend/relay/tasks/scheduler.py`, `backend/relay/tasks/__init__.py` (drop `next_routine_date`), `backend/relay/app.py`
- Create: `backend/tests/automation_helpers.py`
- Test: `backend/tests/unit/test_automation_clock.py` (new); migrate the routine tests in `backend/tests/unit/test_task_scheduler.py`; switch other `promote_due_routine` callers in tests to `fire_now`

**Interfaces:**
- Consumes: `next_fire_after`, `resolve_timezone`, `summarize`, `ScheduleError` (Task 6); `schedule_triggers` (Task 7); `list_due_schedules`, `list_unseeded_schedules` (Task 9).
- Produces:

```python
# clock.py
def next_run_at(task: dict[str, Any], after: datetime) -> str | None          # earliest next fire across schedule triggers, ISO UTC
def seed_from_legacy(task: dict[str, Any], now: datetime) -> str | None
class ScheduleClock:
    def __init__(self, *, task_store: Any, automation_store: Any) -> None: ...
    def run(self, now: datetime) -> int                                       # automations marked pending

# service.py
class AutomationService:
    def __init__(self, *, task_store, session_store, automation_store, project_store, max_runs_per_hour: int, batch: int) -> None
    def tick(self, now: datetime) -> int                                       # occurrences fired

# automation_store.py
def mark_pending(self, routine_id: str, event: dict[str, Any], now: datetime) -> None

# tests/automation_helpers.py
def fire_now(task_store, routine_id, *, run_date="2026-10-13", kind="schedule") -> dict | None
```

`AutomationService.__init__` builds `ScheduleClock`, `AutomationMatcher`, and `AutomationFiring` itself; `TaskScheduler` takes `automations: AutomationService | None` and `_tick_sync` reports `fired=self.automations.tick(self._now()) if self.automations else 0, promoted=0`. Add a `now: Callable[[], datetime]` parameter to `TaskScheduler` (default `lambda: datetime.now(timezone.utc)`) beside `today`. In `app.py`, `task_scheduler_from_env` always builds the service (the automation store is database-only and always present).

- [ ] **Step 1: Write the failing clock tests**

```python
from datetime import datetime, timezone
from tempfile import TemporaryDirectory

import pytest
from relay.automations.clock import ScheduleClock
from relay.persistence.automation_store import DatabaseAutomationStore
from relay.persistence.store_common import store_transaction
from relay.persistence.task_store import DatabaseTaskStore

UTC = timezone.utc
DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]
DAILY_7 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "07:00"}}}]


@pytest.fixture
def world(monkeypatch):
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_TIMEZONE", "UTC")
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/relay.db"
        tasks = DatabaseTaskStore(url, create_schema=True)
        automations = DatabaseAutomationStore(url, create_schema=True)
        yield tasks, automations, ScheduleClock(task_store=tasks, automation_store=automations)


def _routine(tasks, **extra):
    return tasks.create_task({"title": "Digest", "isRoutine": True, "routineTriggers": DAILY_9,
                              "routineState": "active", "assignedAgent": "codex", "assignedAgentId": "a1", **extra})


def test_unseeded_schedule_gets_next_run_without_firing(world):
    tasks, automations, clock = world
    routine = _routine(tasks)
    assert clock.run(datetime(2026, 10, 13, 8, tzinfo=UTC)) == 0
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
    assert automations.get_state(routine["id"])["pending"] is False


def test_legacy_routine_seeds_from_its_date_and_fires_when_past(world):
    tasks, automations, clock = world
    routine = tasks.create_task({"title": "Old", "isRoutine": True, "routineCadence": "daily",
                                 "routineNextRunDate": "2026-10-12", "routineEnabled": True, "assignedAgent": "codex"})
    assert clock.run(datetime(2026, 10, 13, 8, tzinfo=UTC)) == 1   # seeded 2026-10-12T00:00Z, already due
    assert automations.get_state(routine["id"])["pending"] is True
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T00:00:00+00:00"


def test_due_schedule_marks_pending_and_advances(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 9, 0, 5, tzinfo=UTC)) == 1
    state = automations.get_state(routine["id"])
    assert state["pending"] and state["pending_events"][0]["eventType"] == "schedule"
    assert state["pending_events"][0]["summary"] == "Daily at 09:00 (UTC)"
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T09:00:00+00:00"


def test_missed_slots_collapse_to_one(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-10T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 12, tzinfo=UTC)) == 1
    assert len(automations.get_state(routine["id"])["pending_events"]) == 1
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-14T09:00:00+00:00"


def test_once_clears_next_run_after_firing(world):
    tasks, _, clock = world
    once = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"once": "2026-10-13T09:00"}}}]
    routine = _routine(tasks, routineTriggers=once, routineNextRunAt="2026-10-13T09:00:00+00:00")
    clock.run(datetime(2026, 10, 13, 9, 1, tzinfo=UTC))
    assert "routineNextRunAt" not in tasks.get_task(routine["id"])


def test_paused_routine_is_ignored(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineState="paused", routineNextRunAt="2026-10-13T09:00:00+00:00")
    assert clock.run(datetime(2026, 10, 13, 10, tzinfo=UTC)) == 0
    assert automations.get_state(routine["id"])["pending"] is False


def test_earliest_of_two_schedules_wins(world):
    tasks, _, clock = world
    routine = _routine(tasks, routineTriggers=[*DAILY_9, *DAILY_7])
    clock.run(datetime(2026, 10, 13, 6, tzinfo=UTC))
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T07:00:00+00:00"


def test_summary_names_the_trigger_that_came_due(world):
    tasks, automations, clock = world
    routine = _routine(tasks, routineTriggers=[*DAILY_9, *DAILY_7], routineNextRunAt="2026-10-13T07:00:00+00:00")
    clock.run(datetime(2026, 10, 13, 7, 0, 5, tzinfo=UTC))
    assert automations.get_state(routine["id"])["pending_events"][0]["summary"] == "Daily at 07:00 (UTC)"


def test_failed_pending_write_does_not_advance(world, monkeypatch):
    tasks, automations, clock = world
    routine = _routine(tasks, routineNextRunAt="2026-10-13T09:00:00+00:00")
    monkeypatch.setattr(automations, "mark_pending", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    with pytest.raises(RuntimeError):
        with store_transaction(automations.engine):
            clock.run(datetime(2026, 10, 13, 9, 1, tzinfo=UTC))
    assert tasks.get_task(routine["id"])["routineNextRunAt"] == "2026-10-13T09:00:00+00:00"
```

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_clock.py -q` → FAIL.

- [ ] **Step 3: Implement `clock.py`**

```python
"""The schedule clock: turns due schedule triggers into pending automation
events. It never promotes an occurrence — firing does — so schedules
coalesce behind an in-flight run and pause on a missing target exactly like
every other trigger. The clock is also the only writer of
``routineNextRunAt``'s advance, because only it may resolve the server
timezone (the reducer stays pure)."""

from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Any

from loguru import logger

from .model import schedule_triggers
from .schedule import ScheduleError, next_fire_after, resolve_timezone, summarize


def next_run_at(task: dict[str, Any], after: datetime) -> str | None:
    fires = [fire for trigger in schedule_triggers(task)
             if (fire := next_fire_after(trigger["schedule"], after)) is not None]
    return min(fires).isoformat() if fires else None


def seed_from_legacy(task: dict[str, Any], now: datetime) -> str | None:
    """A legacy routine keeps its next run date (start of day, server zone);
    anything else starts from the next fire after now."""
    try:
        day = date.fromisoformat(task["routineNextRunDate"]) if task.get("routineNextRunDate") else None
    except ValueError:
        day = None
    if day is not None:
        zone = resolve_timezone(None)
        return datetime(day.year, day.month, day.day, tzinfo=zone).astimezone(timezone.utc).isoformat()
    return next_run_at(task, now)


def _due_summary(task: dict[str, Any]) -> str:
    due_at = task.get("routineNextRunAt")
    triggers = schedule_triggers(task)
    for trigger in triggers:
        due = datetime.fromisoformat(due_at) if due_at else None
        if due is not None and next_fire_after(trigger["schedule"], due.replace(microsecond=0) - _EPSILON) == due:
            return summarize(trigger["schedule"])
    return summarize(triggers[0]["schedule"]) if triggers else "Schedule"


class ScheduleClock:
    def __init__(self, *, task_store: Any, automation_store: Any) -> None:
        self.task_store = task_store
        self.automation_store = automation_store

    def run(self, now: datetime) -> int:
        for routine in self.task_store.list_unseeded_schedules():
            self._seed(routine, now)
        marked = 0
        for routine in self.task_store.list_due_schedules(now):
            marked += self._fire_slot(routine, now)
        return marked

    def _seed(self, routine: dict[str, Any], now: datetime) -> None:
        try:
            seeded = seed_from_legacy(routine, now)
        except ScheduleError as error:
            self._pause_invalid(routine, error)
            return
        self.task_store.update_task(routine["id"], {"routineNextRunAt": seeded})

    def _fire_slot(self, routine: dict[str, Any], now: datetime) -> int:
        try:
            following = next_run_at(routine, now)
            summary = _due_summary(routine)
        except ScheduleError as error:
            self._pause_invalid(routine, error)
            return 0
        self.automation_store.mark_pending(routine["id"], {"eventType": "schedule", "summary": summary, "depth": 0}, now)
        self.task_store.update_task(routine["id"], {"routineNextRunAt": following})
        logger.info("Automation schedule due", routine_id=routine["id"], next_run_at=following)
        return 1

    def _pause_invalid(self, routine: dict[str, Any], error: Exception) -> None:
        logger.warning("Automation schedule invalid", routine_id=routine["id"], error=str(error))
        self.task_store.update_task(routine["id"], {"routineState": "paused_by_relay",
                                                    "routinePauseReason": "invalid_schedule",
                                                    "routineNextRunAt": None})
```

with `from datetime import timedelta` and `_EPSILON = timedelta(seconds=1)` at module top. In `test_legacy_routine_seeds_from_its_date_and_fires_when_past`, the seeded routine must be due in the same `run` call: re-fetch after seeding — `run` seeds first, then lists due schedules, so the freshly seeded row is included. `update_task` must accept `routineNextRunAt`, `routineState`, and `routinePauseReason` (Task 9 extended the allowlist).

`AutomationService.tick`:

```python
    def tick(self, now: datetime) -> int:
        try:
            with store_transaction(self.automation_store.engine) as conn:
                if conn.dialect.name == "postgresql" and not conn.scalar(
                    text("SELECT pg_try_advisory_xact_lock(:key)"), {"key": AUTOMATION_LOCK_KEY}
                ):
                    return 0
                self.clock.run(now)
                self.matcher.drain(now)
                return self.firing.fire(now)
        except Exception:
            logger.exception("Automation tick failed")
            return 0
```

`store_transaction` joins an open transaction, so the clock's `update_task` and `mark_pending` commit together — `test_failed_pending_write_does_not_advance` pins that. If the test shows the task store opens its own connection instead of joining, stop and report: the "crash re-fires at most once" guarantee needs the stores to share the transaction.

- [ ] **Step 4: Delete the legacy promotion code** listed under Files, and `request_manual_occurrence`'s `today=` matcher argument. Create `backend/tests/automation_helpers.py`:

```python
"""Shortcuts for tests that need an automation occurrence but are not
testing how automations fire."""


def fire_now(task_store, routine_id, *, run_date="2026-10-13", kind="schedule"):
    return task_store.create_triggered_occurrence(
        routine_id, run_date=run_date, trigger_kind=kind, depth=0, context="", summary=None, allow_paused=True)
```

(`allow_paused` is added in Task 11; until then omit it and make the routine active in the test.)

Migrate scheduler tests: `test_scheduler_promotes_due_routine_and_advances_next_run` → covered by `test_due_schedule_marks_pending_and_advances` plus Task 11's firing tests (delete). `test_scheduler_records_skip_activity_once_for_agentless_due_routine` → replaced by Task 11's `test_missing_target_pauses_with_no_target` (delete). `test_scheduler_materializes_legacy_routine_before_promotion` → rewrite against the DB fixture: a legacy-assignment routine due now is promoted after one `AutomationService.tick` and its occurrence carries the materialized assignment. `test_next_routine_date_skips_past_missed_windows_and_handles_custom` → delete (schedule tests cover it). `test_scheduler_promotes_team_routine_into_team_owned_thread` → rewrite against the DB fixture with a v2 team routine due now. Every other test calling `promote_due_routine` switches to `fire_now`. Finally `grep -rn "promote_due_routine\|next_routine_date\|list_due_routines" backend` → no hits.

Add the integration test (spec §5) to `test_task_scheduler.py`, extending its existing dispatch test (`grep -n "def test_scheduler_dispatches" backend/tests/unit/test_task_scheduler.py`): a v2 routine with `routineTriggers` weekday 09:00 UTC and `routineNextRunAt` = 2026-10-13T09:00Z (a Tuesday), scheduler `now` = 09:00:05Z; after one tick the fake backend received exactly one run for the occurrence, and the routine's `routineNextRunAt` is 2026-10-14T09:00Z.

- [ ] **Step 5: Run** `cd backend && uv run pytest -q` → PASS except tests Tasks 11–12 own (matcher fixtures still using `routineTrigger`/`routineEnabled`, API tests). Record that list in the commit body.
- [ ] **Step 6: Commit** — `git commit -am "feat: fire schedule triggers through the automation pending path"`

### Task 11: Matcher and firing v2

**Files:**
- Modify: `backend/relay/automations/matcher.py` (`_targets`)
- Modify: `backend/relay/automations/firing.py` (`_fire_one`, new `pause`, `triggered_target`, `fired_kind`; constructor gains `project_store`, loses `today`)
- Modify: `backend/relay/persistence/task_store.py` (`create_triggered_occurrence` gains `allow_paused: bool = False`; `triggered_occurrence_allowed(routine, *, allow_paused)` checks `is_active(routine) or (allow_paused and routine.get("isRoutine") and not routine.get("deletedAt"))` plus the existing target check)
- Modify: `backend/relay/automations/context.py` (`EVENT_LABELS["schedule"] = "Schedule"`; `_event_line` returns `f"Schedule: {event['summary']}"` for schedule events)
- Modify: `web/src/lib/automationOpening.ts` (add `Schedule: "schedule"` to `EVENT_TYPES_BY_LABEL`; parse `Schedule: <summary>` into `{ kind: "schedule"; summary: string }` and add that member to `OpeningEvent`), `web/src/components/AutomationOpening.tsx` (render it), `web/tests/automationOpening.test.ts` if present (else add the case to the nearest existing opening test: `grep -rln automationOpening web/tests`)
- Test: `backend/tests/unit/test_automation_matcher.py`

**Interfaces:**
- Consumes: `triggers_of`, `is_active`, `has_webhook`, `event_matches`, `EVENT_KINDS` (Task 7); `AutomationService` (Task 10).
- Produces: `AutomationFiring.pause(routine_id: str, reason: str, message: str) -> None` (used by Task 15). Occurrences may carry `routineTriggerKind: "schedule"`. `run_date` passed to `create_triggered_occurrence` is `now.astimezone(resolve_timezone(None)).date().isoformat()`.

Target rules (`AutomationMatcher._targets`):

```python
        target_id = row.get("target_routine_id")
        if target_id:
            target = self._load(target_id)
            if not target:
                return []
            if row["kind"] == "manual":
                # Run now speaks for itself, even on a paused automation — but not
                # when Relay paused it for runaway volume.
                return [] if target.get("routinePauseReason") == "rate_limited" else [target]
            return [target] if is_active(target) and has_webhook(target) else []
        matched = []
        for task in automations.values():
            owner = task.get("ownerUserId")
            subject = event.get("subject") or {}
            if owner and owner not in (subject.get("ownerUserId"), subject.get("assigneeUserId")):
                continue
            if any(trigger.get("kind") in EVENT_KINDS and event_matches(trigger, event) for trigger in triggers_of(task)):
                matched.append(task)
        return matched
```

`any(...)` makes duplicate triggers match once. Stored triggers are already normalized on write.

Firing rules (`AutomationFiring._fire_one`, replacing the enabled/kind check, the old rate-cap pause, the schedule `due_date` block, and the "could not start" branch):

```python
    def _fire_one(self, state: dict[str, Any], now: datetime) -> bool:
        routine_id = state["routine_id"]
        routine = self._load(routine_id)
        events = state["pending_events"]
        manual = any(event.get("eventType") == "manual" for event in events)
        scheduled_only = all(event.get("eventType") == "schedule" for event in events)
        runnable = routine and (is_active(routine) or (manual and routine.get("routinePauseReason") != "rate_limited"))
        if not runnable:
            self.automation_store.clear_state(routine_id)
            return False
        if now - _aware(state["pending_since"]) > PENDING_TTL:
            ...unchanged expiry...
        if in_flight_occurrence(self.task_store, routine):
            return False
        if not triggered_target(routine, self.project_store):
            self.pause(routine_id, "no_target", "Automation paused: it has no agent, team, or open project to run on.")
            return False
        window_start = _aware(state["fired_window_start"])
        count = int(state["fired_count"])
        if window_start is None or now - window_start >= RATE_WINDOW:
            window_start, count = now, 0
        if not scheduled_only and count >= self.max_runs_per_hour:
            self.pause(routine_id, RATE_LIMITED, f"Automation paused: more than {self.max_runs_per_hour} runs in an hour.")
            return False
        kind = fired_kind(events, manual)
        occurrence = self.task_store.create_triggered_occurrence(
            routine_id,
            run_date=now.astimezone(resolve_timezone(None)).date().isoformat(),
            trigger_kind=kind,
            summary={"eventType": "manual" if manual else events[0]["eventType"],
                     "eventCount": len(events) + int(state["pending_dropped"]),
                     **({"toStatus": events[0]["toStatus"]} if events[0].get("toStatus") else {})},
            depth=max(int(event.get("depth") or 0) for event in events),
            context=trigger_context_block(events, int(state["pending_dropped"]), fired_by="manual" if manual else None),
            allow_paused=manual,
        )
        if not occurrence:
            logger.info("Automation could not start", routine_id=routine_id)
            return False
        self.automation_store.save_state(routine_id, {
            **state, "pending": False, "pending_events": [], "pending_dropped": 0, "pending_since": None,
            "fired_window_start": window_start, "fired_count": count if scheduled_only else count + 1,
        })
        logger.info("Automation fired", routine_id=routine_id, occurrence_id=occurrence["id"], kind=kind, events=len(events))
        return True

    def pause(self, routine_id: str, reason: str, message: str) -> None:
        self.task_store.update_task(routine_id, {"routineState": "paused_by_relay", "routinePauseReason": reason,
                                                 "routineNextRunAt": None})
        self.task_store.record_activity(routine_id, message)
        logger.warning("Automation paused", routine_id=routine_id, reason=reason)
        self.automation_store.clear_state(routine_id)


def fired_kind(events: list[dict[str, Any]], manual: bool) -> str:
    if manual:
        return "manual"
    event_type = events[0]["eventType"]
    if event_type in ("schedule", "webhook"):
        return event_type
    return "task_event" if event_type.startswith("task.") else "run_event"


def triggered_target(routine: dict[str, Any], project_store: Any) -> bool:
    if routine.get("projectId"):
        project = project_store.get_project(routine["projectId"]) if project_store else None
        return not project_work_error(project)
    return bool(routine.get("assignedAgent") or routine.get("assignedTeamId"))
```

Keep `save_state`'s `**state` spread so `consecutive_failures` survives (Task 15). If the old `_fire_one` called `self._materialize_legacy_assignment` (via the clock) before promotion, keep that call ahead of `triggered_target`; check the PR 1 version of `clock.py`.

- [ ] **Step 1: Update the matcher test fixture to v2** — `_automation` creates `{"isRoutine": True, "routineState": "active", "routineTriggers": [trigger], "assignedAgent": "codex", "assignedAgentId": "agent_1", ...}`. Build the service in `world`: `service = AutomationService(task_store=tasks, session_store=sessions, automation_store=automations, project_store=None, max_runs_per_hour=6, batch=200)`, and add `def run(world): return world[2].tick(world[3].value)`. Replace every `matcher.run()` with `run(world)`. Then add:

```python
def test_any_of_several_triggers_fires(world):
    tasks, _, _, _ = world
    routine = _automation(tasks, routineTriggers=[
        {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "done"}}, ON_BLOCKED])
    _block(tasks)
    assert run(world) == 1
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_duplicate_triggers_mark_pending_once(world):
    tasks, automations, service, clock = world
    routine = _automation(tasks, routineTriggers=[ON_BLOCKED, ON_BLOCKED])
    _block(tasks)
    service.matcher.drain(clock.value)
    assert len(automations.get_state(routine["id"])["pending_events"]) == 1


def test_schedule_fires_do_not_count_toward_rate_cap(world):
    tasks, automations, service, clock = world
    routine = _automation(tasks, routineTriggers=[{"kind": "schedule", "schedule": {
        "timezone": "UTC", "repeat": {"every": "hour", "minute": 0}}}])
    for _ in range(7):
        automations.mark_pending(routine["id"], {"eventType": "schedule", "summary": "Hourly", "depth": 0}, clock.value)
        assert run(world) == 1
        for occurrence in _occurrences(tasks, routine["id"]):
            tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    assert tasks.get_task(routine["id"])["routineState"] == "active"


def test_event_fires_still_hit_the_rate_cap(world):
    tasks, _, _, clock = world
    routine = _automation(tasks)
    for index in range(7):
        _block(tasks, f"t{index}")
        run(world)
        for occurrence in _occurrences(tasks, routine["id"]):
            tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    task = tasks.get_task(routine["id"])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "rate_limited")


def test_missing_target_pauses_with_no_target(world):
    tasks, _, _, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None)
    _block(tasks)
    assert run(world) == 0
    task = tasks.get_task(routine["id"])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "no_target")


def test_run_now_fires_while_paused_by_owner(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineState="paused")
    automations.enqueue_manual(routine["id"])
    assert run(world) == 1
    assert tasks.get_task(routine["id"])["routineState"] == "paused"


def test_run_now_ignored_when_rate_limited(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineState="paused_by_relay", routinePauseReason="rate_limited")
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    assert _occurrences(tasks, routine["id"]) == []


def test_run_now_without_target_pauses(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, assignedAgent=None, assignedAgentId=None)
    automations.enqueue_manual(routine["id"])
    assert run(world) == 0
    assert tasks.get_task(routine["id"])["routinePauseReason"] == "no_target"


def test_schedule_occurrence_is_stamped_schedule(world):
    tasks, automations, _, clock = world
    routine = _automation(tasks, routineTriggers=[])
    automations.mark_pending(routine["id"], {"eventType": "schedule", "summary": "Daily at 09:00 (UTC)", "depth": 0}, clock.value)
    run(world)
    [occurrence] = _occurrences(tasks, routine["id"])
    assert occurrence["routineTriggerKind"] == "schedule"
    assert "Fired by: Schedule" in occurrence["description"]
```

(Import `timedelta`. `_automation`'s `**extra` overrides the defaults.)

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/unit/test_automation_matcher.py -q` → new tests FAIL.
- [ ] **Step 3: Implement** the target rules, firing rules, context label, and web opening parse. Delete `trigger_of`, `trigger_kind`, and `SCHEDULE_TRIGGER` from `model.py` if `grep -rn "trigger_of\|trigger_kind\|SCHEDULE_TRIGGER" backend/relay` shows only Task 12's call sites remaining (then delete them in Task 12).
- [ ] **Step 4: Run** `cd backend && uv run pytest tests/unit -q` → PASS; `cd web && npx vitest run tests/automationOpening.test.ts` (or the file you extended) → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat: match every trigger and pause automations Relay cannot run"`

### Task 12: API v2 — create/patch validation, preview, Run now, webhook gate

**Files:**
- Modify: `backend/relay/automations/service.py` — replace `routine_fields` with `routine_fields_v2`; `validate_trigger_scope` loops over every trigger; `request_manual_occurrence` checks `routinePauseReason == "rate_limited"` instead of `routineEnabled`, and builds an `AutomationService` for its immediate tick
- Modify: `backend/relay/api/task_routes.py` — create (~line 548) and patch (~line 711) call `routine_fields_v2` (translate `TriggerError` → `HTTPException(400)`); the `capabilities.automationTriggers` gate rejects any non-schedule kind in `routineTriggers`; the "needs a target before enabling" check reads `routineState == "active"`; after a patch that sets `active` on a `paused_by_relay` routine, call `automation_store.reset_rate_window(task_id)`
- Modify: `backend/relay/api/automation_routes.py` — webhook receiver gate (line ~77) uses `is_active(routine) and has_webhook(routine)`; the webhook-secret routes check `has_webhook`; add `POST /automations/schedule-preview`
- Modify: `backend/relay/api/session_routes.py:143` — the task summary returns `routineTriggers`, `routineState`, `routineNextRunAt` instead of the four legacy keys
- Modify: `backend/relay/persistence/store_common.py`, `backend/relay/core/models.py` — delete `task_routine_type`, `task_routine_cadence`, `TaskRoutineType`, `TaskRoutineCadence` once unused
- Test: `backend/tests/api/test_automation_triggers_api.py` (rewrite fixtures to v2 + new cases), `backend/tests/api/test_automation_webhook.py` (fixtures to v2), `backend/tests/api/test_automation_schedule_preview.py` (new); other API tests that post legacy routine fields (`grep -rln "routineCadence\|routineEnabled" backend/tests/api`) switch to v2 bodies

**Interfaces:**
- Consumes: `normalize_triggers`, `LEGACY_FIELDS`, `STATES`, `state_of`, `is_active`, `has_webhook` (Task 7); `next_run_at` (Task 10); `normalize_schedule`, `next_fires`, `summarize` (Task 6).
- Produces:

```python
def routine_fields_v2(body: dict[str, Any], *, current: dict[str, Any] | None, now: datetime) -> dict[str, Any]
# raises TriggerError; returns the routine slice of a task.created / task.updated payload
```

```python
def routine_fields_v2(body: dict[str, Any], *, current: dict[str, Any] | None, now: datetime) -> dict[str, Any]:
    legacy = [field for field in LEGACY_FIELDS if field in body]
    if legacy:
        raise TriggerError(f"{legacy[0]} was replaced by routineTriggers and routineState; see docs/api.md.")
    touched = {"isRoutine", "routineTriggers", "routineState"} & set(body)
    if not touched:
        return {}
    is_routine = bool(body["isRoutine"]) if "isRoutine" in body else bool((current or {}).get("isRoutine", True))
    if not is_routine:
        return {"isRoutine": False}
    if "routineState" in body and body["routineState"] not in ("active", "paused"):
        raise TriggerError("routineState must be active or paused; only Relay pauses an automation.")
    triggers = (normalize_triggers(body["routineTriggers"]) if "routineTriggers" in body
                else triggers_of(current or {}))
    state = body.get("routineState") or (state_of(current) if current else "paused")
    fields: dict[str, Any] = {"isRoutine": True, "routineTriggers": triggers, "routineState": state}
    if state == "active":
        fields["routinePauseReason"] = None
    if state == "active":
        fields["routineNextRunAt"] = next_run_at({"routineTriggers": triggers}, now)
    else:
        fields["routineNextRunAt"] = None
    return fields
```

When a field changes nothing (state stays `paused_by_relay` because the body didn't touch state), keep the current state: `state_of(current)` covers it, and `routineNextRunAt` stays `None` as the reducer already has it. A PATCH that sends only `title` returns `{}` (no routine keys touched).

Preview endpoint (in `automation_routes.py`):

```python
@router.post("/automations/schedule-preview")
async def preview_schedule(request: Request, ctx: AppContextDep) -> dict[str, Any]:
    await run_in_threadpool(request_actor, request, ctx.auth_store)
    body = await json_body(request)
    try:
        schedule = normalize_schedule(body.get("schedule"))
    except ScheduleError as error:
        raise HTTPException(400, str(error)) from error
    fires = next_fires(schedule, datetime.now(timezone.utc), 3)
    return {"summary": summarize(schedule), "next": [fire.isoformat() for fire in fires]}
```

- [ ] **Step 1: Write the failing API tests.** Reuse the file's existing client/actor fixtures and constants (`grep -n "def client\|AGENT_ID\|headers" backend/tests/api/test_automation_triggers_api.py | head`). New cases:

```python
DAILY_9 = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "09:00"}}}]


def test_create_v2_automation_computes_next_run(client):
    task = client.post("/api/v1/tasks", json={"title": "Digest", "isRoutine": True, "assignedAgentId": AGENT_ID,
                                              "routineState": "active", "routineTriggers": DAILY_9}).json()
    assert task["routineState"] == "active"
    assert task["routineNextRunAt"].endswith("T09:00:00+00:00")


@pytest.mark.parametrize("field", ["routineCadence", "routineType", "routineEnabled", "routineTrigger", "routineNextRunDate"])
def test_legacy_fields_rejected(client, field):
    response = client.post("/api/v1/tasks", json={"title": "x", "isRoutine": True, field: "daily"})
    assert response.status_code == 400
    assert field in response.json()["detail"]


def test_owner_cannot_set_paused_by_relay(client):
    response = client.post("/api/v1/tasks", json={"title": "x", "isRoutine": True, "routineTriggers": [],
                                                  "routineState": "paused_by_relay"})
    assert response.status_code == 400 and "only Relay" in response.json()["detail"]


def test_six_triggers_rejected(client):
    response = client.post("/api/v1/tasks", json={"title": "x", "isRoutine": True, "routineTriggers": DAILY_9 * 6})
    assert response.status_code == 400 and "at most 5" in response.json()["detail"]


def test_bad_schedule_names_the_path(client):
    bad = [{"kind": "schedule", "schedule": {"timezone": "UTC", "repeat": {"every": "day", "at": "9am"}}}]
    response = client.post("/api/v1/tasks", json={"title": "x", "isRoutine": True, "routineTriggers": bad})
    assert response.status_code == 400 and "routineTriggers[0].schedule.repeat.at" in response.json()["detail"]


def test_pause_clears_next_run_and_resume_recomputes(client):
    task = client.post("/api/v1/tasks", json={"title": "d", "isRoutine": True, "assignedAgentId": AGENT_ID,
                                              "routineState": "active", "routineTriggers": DAILY_9}).json()
    paused = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": "paused"}).json()
    assert "routineNextRunAt" not in paused
    resumed = client.patch(f"/api/v1/tasks/{task['id']}", json={"routineState": "active"}).json()
    assert resumed["routineNextRunAt"].endswith("T09:00:00+00:00")


def test_patch_legacy_routine_with_v2_fields_keeps_schedule(client, task_store):
    legacy = task_store.create_task({"title": "Old", "isRoutine": True, "routineCadence": "weekly",
                                     "routineNextRunDate": "2030-01-02", "routineEnabled": True,
                                     "assignedAgent": "codex", "assignedAgentId": AGENT_ID,
                                     "ownerUserId": OWNER_ID})
    current = client.get(f"/api/v1/tasks/{legacy['id']}").json()
    saved = client.patch(f"/api/v1/tasks/{legacy['id']}", json={
        "title": "Renamed", "routineTriggers": current["routineTriggers"], "routineState": current["routineState"]}).json()
    assert saved["routineTriggers"] == current["routineTriggers"]
    assert saved["routineTriggers"][0]["schedule"]["repeat"] == {"every": "week", "at": "00:00", "days": [3]}
    assert saved["routineNextRunAt"]


def test_capability_off_rejects_event_triggers(client, monkeypatch):
    monkeypatch.setenv("RELAY_AUTOMATION_TRIGGERS_ENABLED", "0")
    response = client.post("/api/v1/tasks", json={"title": "x", "isRoutine": True,
                                                  "routineTriggers": [{"kind": "webhook"}]})
    assert response.status_code == 400


def test_run_now_on_paused_automation_runs(client):
    task = client.post("/api/v1/tasks", json={"title": "d", "isRoutine": True, "assignedAgentId": AGENT_ID,
                                              "routineState": "paused", "routineTriggers": []}).json()
    response = client.post(f"/api/v1/tasks/{task['id']}/runs", json={})
    assert response.status_code == 202
    assert response.json().get("dispatch", {}).get("state") != "rejected"
```

`test_automation_schedule_preview.py`:

```python
def test_schedule_preview_returns_three_fires(client):
    body = client.post("/api/v1/automations/schedule-preview",
                       json={"schedule": {"timezone": "UTC", "repeat": {"every": "hour", "minute": 0}}}).json()
    assert body["summary"] == "Hourly at :00 (UTC)" and len(body["next"]) == 3


def test_schedule_preview_400_names_the_field(client):
    response = client.post("/api/v1/automations/schedule-preview",
                           json={"schedule": {"timezone": None, "repeat": {"cron": "* * * * *"}}})
    assert response.status_code == 400 and "15 minutes" in response.json()["detail"]


def test_schedule_preview_requires_auth(anonymous_client):
    response = anonymous_client.post("/api/v1/automations/schedule-preview", json={"schedule": {}})
    assert response.status_code == 401
```

In `test_automation_webhook.py`, add `test_webhook_409_when_paused` (create an active webhook automation, generate a secret, PATCH `routineState: "paused"`, POST to the webhook with the secret → 409). Match the fixture names (`client`, `anonymous_client`, `task_store`, `OWNER_ID`) to what the files actually provide; if `anonymous_client` doesn't exist, build an unauthenticated `TestClient` the way the file's 401 test does.

- [ ] **Step 2: Run** `cd backend && uv run pytest tests/api/test_automation_triggers_api.py tests/api/test_automation_webhook.py tests/api/test_automation_schedule_preview.py -q` → FAIL.
- [ ] **Step 3: Implement** the service function, route changes, preview endpoint, and deletions.
- [ ] **Step 4: Run** `cd backend && uv run pytest -q` → PASS. Then `grep -rn "routineEnabled\|routineCadence\|routineNextRunDate\|routineType\|routineDisabledReason\|\"routineTrigger\"" backend/relay` — remaining hits may only be `LEGACY_FIELDS`, the reducer, `upgrade_legacy`, `seed_from_legacy`, and comments.
- [ ] **Step 5: Commit** — `git commit -am "feat: accept v2 automation triggers and preview schedules over the API"`

### Task 13: Shared types and the web contract adaptation

**Files:**
- Modify: `packages/relay-core/src/task-store.ts` (routine types ~lines 100–200)
- Create: `web/src/lib/automationSchedule.ts`
- Modify: `web/src/lib/automationTrigger.ts`, `web/src/lib/routine.ts`, `web/src/lib/taskBoardForm.ts`, `web/src/types.ts` (re-exports)
- Create: `web/src/components/task-board/ScheduleFields.tsx`, `web/src/components/task-board/AutomationPauseBanner.tsx`
- Modify: `web/src/components/task-board/{AutomationTriggerFields.tsx,TaskDrawer.tsx,RoutineRecords.tsx,RoutineChrome.tsx}`, `web/src/components/RoutinesPage.tsx`, `web/src/components/task-record/{recordActions.ts,recordBandFacts.tsx,TaskRecordDefinition.tsx,TaskRecordView.tsx,TaskRecordPage.tsx}`, `web/src/components/icons.tsx`
- Modify: the web API client (find with `grep -rln "automation/webhook-secret" web/src/lib`) — add `previewSchedule`
- Modify: `en` and `zh-CN` locale files (`grep -rln "\"automation\"" web/src --include=*.json`)
- Test: `web/tests/automationSchedule.test.ts` (new), `web/tests/{automationTrigger,routine,taskBoardForm}.test.ts`, and every other test listed by `grep -rln "routineCadence\|routineType\|routineEnabled\|routineNextRunDate\|routineDisabledReason\|routineTrigger\b" web/tests`

**Interfaces:**
- Produces (in `relay-core`, re-exported from `web/src/types.ts`):

```ts
export type ScheduleRepeat =
  | { every: "hour"; minute: number }
  | { every: "day" | "weekday"; at: string }
  | { every: "week"; at: string; days: number[] }
  | { every: "month"; at: string; day: number }
  | { once: string }
  | { cron: string };
export interface RoutineSchedule { timezone: string | null; repeat: ScheduleRepeat }
export type RoutineTrigger =
  | { kind: "schedule"; schedule: RoutineSchedule }
  | { kind: "task_event" | "run_event"; on: RoutineTriggerOn; filters?: RoutineTriggerFilters }
  | { kind: "webhook" };
export type RoutineTriggerKind = RoutineTrigger["kind"];
export type RoutineState = "active" | "paused" | "paused_by_relay";
export type RoutinePauseReason = "rate_limited" | "failing" | "no_target" | "invalid_schedule";
// on RelayTask and the task create/update input:
routineTriggers?: RoutineTrigger[];
routineState?: RoutineState;
routinePauseReason?: RoutinePauseReason;
routineNextRunAt?: string;
```

Removed: `routineType`, `routineCadence`, `routineNextRunDate`, `routineEnabled`, `routineTrigger`, `routineDisabledReason`, `TaskRoutineType`, `TaskRoutineCadence`. Occurrence stamps keep `routineTriggerKind` (type `RoutineTriggerKind | "manual"`, since old occurrences carry `manual`). The list-state type in `routine.ts` is renamed `RoutineListState` everywhere, so it no longer collides with the wire `RoutineState`.

`web/src/lib/automationSchedule.ts`:

```ts
import type { RoutineSchedule, ScheduleRepeat } from "../types.js";

/* The schedule presets an automation can use. Mirrors
   backend/relay/automations/schedule.py — except the cron 15-minute floor,
   which only the backend evaluates; the preview endpoint reports it. */

export const SCHEDULE_PRESETS = ["hour", "day", "weekday", "week", "month", "once", "cron"] as const;
export type SchedulePreset = (typeof SCHEDULE_PRESETS)[number];
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const ONCE = /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_AT = "09:00";

export function presetOf(repeat: ScheduleRepeat): SchedulePreset {
  if ("cron" in repeat) return "cron";
  if ("once" in repeat) return "once";
  return repeat.every;
}

export function repeatForPreset(preset: SchedulePreset, previous?: ScheduleRepeat, today = new Date()): ScheduleRepeat {
  const at = previous && "at" in previous ? previous.at : DEFAULT_AT;
  switch (preset) {
    case "hour": return { every: "hour", minute: 0 };
    case "day": return { every: "day", at };
    case "weekday": return { every: "weekday", at };
    case "week": return { every: "week", at, days: [1] };
    case "month": return { every: "month", at, day: 1 };
    case "once": return { once: `${today.toISOString().slice(0, 10)}T${at}` };
    case "cron": return { cron: "0 9 * * 1-5" };
  }
}

export function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function defaultSchedule(): RoutineSchedule {
  return { timezone: browserTimezone(), repeat: { every: "weekday", at: DEFAULT_AT } };
}

/** The i18n key of the first problem the form must show, or null. */
export function scheduleError(schedule: RoutineSchedule): string | null {
  const repeat = schedule.repeat;
  if ("at" in repeat && !TIME.test(repeat.at)) return "automation.errors.time";
  if ("days" in repeat && repeat.days.length === 0) return "automation.errors.days";
  if ("day" in repeat && (repeat.day < 1 || repeat.day > 31)) return "automation.errors.month_day";
  if ("minute" in repeat && (repeat.minute < 0 || repeat.minute > 59)) return "automation.errors.minute";
  if ("once" in repeat && !ONCE.test(repeat.once)) return "automation.errors.once";
  if ("cron" in repeat && repeat.cron.trim().split(/\s+/).length !== 5) return "automation.errors.cron";
  return null;
}
```

`automationTrigger.ts` changes:

```ts
export const TRIGGER_KINDS: readonly RoutineTriggerKind[] = ["schedule", "task_event", "run_event", "webhook"];
export const MAX_TRIGGERS = 5;

export function triggersOf(task: { routineTriggers?: RoutineTrigger[] | null }): RoutineTrigger[] {
  return (task.routineTriggers ?? []).filter((trigger) => TRIGGER_KINDS.includes(trigger.kind));
}

export function triggerForKind(kind: RoutineTriggerKind): RoutineTrigger {
  if (kind === "schedule") return { kind, schedule: defaultSchedule() };
  if (isEventKind(kind)) return { kind, on: TRIGGER_ON[kind][0] };
  return { kind: "webhook" };
}

export function normalizeTriggerForSave(trigger: RoutineTrigger): RoutineTrigger {
  if (trigger.kind === "schedule" || trigger.kind === "webhook") return trigger;
  ...existing event normalization...
}

export function triggersEqual(a: RoutineTrigger[], b: RoutineTrigger[]): boolean {
  return JSON.stringify(a.map(normalizeTriggerForSave)) === JSON.stringify(b.map(normalizeTriggerForSave));
}

/** One short phrase for what starts an automation: record band and list column. */
export function describeTriggers(triggers: RoutineTrigger[], t: Translate): string {
  if (triggers.length === 0) return t("automation.run_now_only");
  if (triggers.length > 1) return t("automation.trigger_count", { count: triggers.length });
  return describeTrigger(triggers[0], t);
}
```

`describeTrigger` for `schedule` returns `t(\`automation.presets.${presetOf(trigger.schedule.repeat)}\`)`. `FIRED_BY_KEYS` gains `schedule: "schedule"` (add `automation.ledger.schedule`). `triggerOf` and `SCHEDULE_TRIGGER` are removed.

`taskBoardForm.ts` routine variant:

```ts
  variant: "routine";
  routineTriggers: RoutineTrigger[];
  routineState: RoutineState;
  routinePauseReason?: RoutinePauseReason;
```

The default is `routineTriggers: [{ kind: "schedule", schedule: defaultSchedule() }]` with `routineState: "paused"`. Equality uses `triggersEqual(...) && a.routineState === b.routineState`. The request body sends `routineTriggers: form.routineTriggers.map(normalizeTriggerForSave)` and `routineState`, and nothing else routine-related. The "cleared" path (`taskBoardForm.ts:180`) sets `routineState: "paused"`.

`TaskDrawer.tsx` `RoutineSchedule`:
- With **0 or 1 triggers**, it renders `TriggerKindField`, whose options are `TRIGGER_KINDS` plus `"none"` (label `automation.kinds.none`, "Run now only", mapping to `[]`). The value is `triggers[0]?.kind ?? "none"`. Below it go `ScheduleFields` for a schedule, `EventTriggerFields` for an event, `WebhookSecretPanel` for a webhook, or the existing `automation.manual_hint` paragraph for none.
- With **2+ triggers**, it renders a read-only `<ul>` of `describeTrigger` per trigger and the hint `automation.multi_trigger_readonly`.
- The Issue/Job `Field` and the cadence and next-run fields are deleted.
- The switch is checked when `routineState === "active"`. `onCheckedChange` sets `routineState: checked ? "active" : "paused"`. It is disabled under the same no-target rule as today. When `routineState === "paused_by_relay"`, `AutomationPauseBanner` renders above the switch, and turning the switch on is the resume.

`ScheduleFields.tsx` props are `{ schedule: RoutineSchedule; onChange(next: RoutineSchedule): void }`. Fields:
- preset `Select` (`automation.presets.<preset>`), via `repeatForPreset(preset, schedule.repeat)`;
- `at`: `Input type="time"`;
- `week`: seven toggle buttons, `aria-pressed`, labels `automation.weekdays.1`..`7`, at least one required;
- `month`: `Input type="number" min={1} max={31}`;
- `hour`: `Input type="number" min={0} max={59}`;
- `once`: `Input type="datetime-local"`;
- `cron`: monospace `Input`;
- timezone `Select` with options for the browser zone, `UTC`, the current value if different, and "Server time" (`null`).

Under the fields sits a preview line: `useQuery({ queryKey: ["schedule-preview", JSON.stringify(schedule)], queryFn: () => previewSchedule(schedule), enabled: !scheduleError(schedule) })`. The input it uses is debounced 300 ms through the existing debounce hook (`grep -rn "export function useDebounced" web/src`; if none, use `useDeferredValue`). It shows `summary` plus the first `next` time formatted with `Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" })`. A 400 error message appears as the field error. Use the existing `Field`, `Select`, and `Input` components the way `AutomationTriggerFields.tsx` does.

`AutomationPauseBanner.tsx`: when `task.routineState === "paused_by_relay"`, it renders `t(\`automation.paused_reasons.${task.routinePauseReason ?? "rate_limited"}\`)` in the same notice style the rate-limit hint uses today. There is no Resume button yet (Task 15).

List (`routine.ts`, `RoutineRecords.tsx`, `RoutineChrome.tsx`, `RoutinesPage.tsx`):
- `RoutineFilters` drops `type` and `cadence`. `trigger` is `"all" | "none" | RoutineTriggerKind`, matching `triggersOf(task).length === 0` for `"none"` and `triggersOf(task).some((x) => x.kind === filter)` otherwise.
- The Cadence column becomes **Next run** (`routine.next_run_column`), formatted from `routineNextRunAt`, or "—" when absent. The Type column goes away.
- `RoutineListState`:
  - `running` when an occurrence is in flight (unchanged);
  - `paused` when the state isn't `active`;
  - `listening` when any non-schedule trigger exists and there is no next run;
  - `on_demand` when there are no triggers;
  - `due` when `routineNextRunAt` ≤ now;
  - `scheduled` otherwise.
- Remove `overdue` and `unscheduled`, and their `routine.states.*` keys.

- [ ] **Step 1: Write the failing web unit tests**

```ts
// web/tests/automationSchedule.test.ts
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SCHEDULE_PRESETS, presetOf, repeatForPreset, scheduleError } from "../src/lib/automationSchedule.ts";

describe("automationSchedule", () => {
  it("round-trips every preset", () => {
    for (const preset of SCHEDULE_PRESETS) assert.equal(presetOf(repeatForPreset(preset)), preset);
  });
  it("keeps the time when switching day → weekday", () => {
    assert.deepEqual(repeatForPreset("weekday", { every: "day", at: "07:45" }), { every: "weekday", at: "07:45" });
  });
  it("flags each bad field", () => {
    assert.equal(scheduleError({ timezone: null, repeat: { every: "day", at: "25:00" } }), "automation.errors.time");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "week", at: "09:00", days: [] } }), "automation.errors.days");
    assert.equal(scheduleError({ timezone: null, repeat: { every: "month", at: "09:00", day: 0 } }), "automation.errors.month_day");
    assert.equal(scheduleError({ timezone: null, repeat: { once: "soon" } }), "automation.errors.once");
    assert.equal(scheduleError({ timezone: null, repeat: { cron: "* *" } }), "automation.errors.cron");
    assert.equal(scheduleError({ timezone: "UTC", repeat: { every: "weekday", at: "09:00" } }), null);
  });
});
```

Add to `automationTrigger.test.ts`:

```ts
  it("describes trigger lists", () => {
    const t = (key: string, options?: Record<string, unknown>) => (options?.count ? `${key}:${options.count}` : key);
    assert.equal(describeTriggers([], t), "automation.run_now_only");
    assert.equal(describeTriggers([{ kind: "webhook" }, { kind: "webhook" }], t), "automation.trigger_count:2");
  });
  it("keeps a schedule unchanged on save", () => {
    const trigger = { kind: "schedule", schedule: { timezone: "UTC", repeat: { every: "day", at: "09:00" } } } as const;
    assert.deepEqual(normalizeTriggerForSave(trigger), trigger);
  });
```

Add to `taskBoardForm.test.ts` a test asserting that the routine request body has `routineTriggers` and `routineState` and none of `routineType`, `routineCadence`, `routineNextRunDate`, `routineEnabled`, `routineTrigger`, `routineDisabledReason`. Find the body builder with `grep -n "export function" web/src/lib/taskBoardForm.ts`.

Add to `routine.test.ts` one assertion per `RoutineListState` branch above, using fixed `now`/`today` arguments.

- [ ] **Step 2: Run** `cd web && npx vitest run tests/automationSchedule.test.ts tests/automationTrigger.test.ts tests/taskBoardForm.test.ts tests/routine.test.ts` → FAIL.
- [ ] **Step 3: Change the types** in `relay-core`. Rebuild it with the workspace name from the root `package.json` (e.g. `npm run build -w packages/relay-core`), then run `cd web && npx tsc --noEmit`. Every error is a call site in the blast radius; fix each one per the rules above. Add locale keys in **both** `en` and `zh-CN`:
  - `automation.presets.{hour,day,weekday,week,month,once,cron}`, `automation.weekdays.{1..7}`, `automation.timezone`, `automation.timezone_server`;
  - `automation.run_now_only`, `automation.trigger_count`, `automation.multi_trigger_readonly`, `automation.kinds.none`, `automation.ledger.schedule`;
  - `automation.paused_reasons.{rate_limited,failing,no_target,invalid_schedule}`, `automation.errors.{time,days,month_day,minute,once,cron}`, `automation.preview_next`;
  - `routine.next_run_column`.

  Delete `routine.types.*`, `routine.cadences.*`, `routine.type`, `routine.cadence`, `routine.states.overdue`, `routine.states.unscheduled`, `routine.next_run_hint`, and `routine.next_run_auto_hint`, but only after `grep -rn "<key>" web/src` shows no users. Keep the existing locale guard test passing: no "routine" / "Routine" / 例行 in values.
- [ ] **Step 4: Implement** the libs and components.
- [ ] **Step 5: Verify.**
  - Run `cd web && npx vitest run && npx tsc --noEmit && npm run lint`. Expected: PASS.
  - Then run the app: `make backend` in one shell and `make web` in another. Sign in, create an automation with a Weekdays 09:00 schedule, confirm the preview shows the next weekday 09:00, save, reopen it, and confirm the preset, time, and timezone round-trip.
  - Switch it to "Run now only" and save. The list's Next run should show "—".
  - Note the result in the PR body. If the dev environment can't run, say so plainly rather than claiming it was verified.
- [ ] **Step 6: Commit**: `git commit -am "feat(web): edit v2 automation schedules and show the next run"`

### Task 14: Docs and invariants

**Files:**
- Modify: `docs/api.md` (automation fields: `grep -n "routineTrigger\|routineCadence\|routineEnabled" docs/api.md`)
- Modify: `CLAUDE.md` (the "Automations are routines on the wire" invariant)
- Modify: `docs/automation-v2-design.md` (Status line)

- [ ] **Step 1:** In `docs/api.md`, replace the legacy routine field docs with:
  - the v2 shapes (spec §1);
  - the 400 answered for a legacy field;
  - `POST /automations/schedule-preview` (request/response, as in Task 12);
  - the note that Run now works on a paused automation except `rate_limited`.
- [ ] **Step 2:** In `CLAUDE.md`, append to the Automations invariant: "v2 fields are `routineTriggers` (0..5, OR-ed), `routineState`, and `routineNextRunAt`; `backend/relay/automations/` is the one seam (`model`, `schedule`, `clock`, `matcher`, `firing`, `service`). Every trigger fires through `automation_state` pending, and the clock — never the reducer — computes next runs, because only it may resolve the server timezone. Legacy `routineCadence`/`routineEnabled`/… events still replay through `upgrade_legacy`; the API rejects them on write."
- [ ] **Step 3:** In the design doc, set `Status: implemented (PR 2). Deviations: docs/plans/2026-10-13-automation-v2.md#deviations-from-the-spec-decided-while-planning`.
- [ ] **Step 4:** Commit with `git commit -am "docs: document automations v2"`, then open PR 2, titled `feat: automations v2 trigger model`. The body lists:
  - the deviations;
  - the behavior changes: schedules coalesce behind an in-flight run, a missing target pauses instead of retrying, Run now works while paused, the API rejects legacy fields, and schedule fires are exempt from the rate cap;
  - the test evidence.

---

# PR 3: Auto-pause on failure, resume

Branch: `mc/automation-v2-autopause`, based on PR 2.

### Task 15: Consecutive failures, auto-pause, resume

**Files:**
- Modify: `backend/relay/persistence/automation_store.py`:
  - `record_outcome`;
  - `_empty_state` gains `consecutive_failures: 0`;
  - `clear_state` keeps `consecutive_failures`;
  - `reset_rate_window` zeroes everything, the counter included.
- Modify: `backend/relay/automations/matcher.py`. `drain` records occurrence outcomes before matching.
- Modify: `backend/relay/automations/firing.py`. Add `FAILURE_LIMIT = 3`.
- Modify: `backend/relay/automations/service.py`. Add `resume`.
- Modify: `backend/relay/api/automation_routes.py`. Add `POST /tasks/{task_id}/automation/resume`.
- Modify: `web/src/components/task-board/AutomationPauseBanner.tsx` (Resume button), the web API client (`resumeAutomation`), and the locale keys `automation.resume` and `automation.resumed_toast` in en and zh-CN.
- Test: `backend/tests/unit/test_automation_matcher.py`, `backend/tests/api/test_automation_triggers_api.py`, and `web/tests/automationPauseBanner.test.tsx` (new). Mirror the render setup of an existing component test (`grep -rln "render(" web/tests | head -3`), and stub base-ui popups as those tests do.

**Interfaces:**
- Consumes: `AutomationFiring.pause` (Task 11), `next_run_at` (Task 10), `is_active` (Task 7).
- Produces:

```python
# automation_store.py
def record_outcome(self, routine_id: str, failed: bool) -> int    # the new consecutive-failure count

# service.py
def resume(self, task_id: str, actor: dict[str, Any], now: datetime) -> dict[str, Any]
```

`resume` behaves as follows:
- Owner or admin only; anyone else gets `PermissionError`, which the route maps to 403.
- On an already-active task it returns the task unchanged.
- Otherwise it calls `reset_rate_window(task_id)`, which clears pending, the rate window, and failures, then `update_task(task_id, {"routineState": "active", "routinePauseReason": None, "routineNextRunAt": next_run_at(task, now)})`, and returns the updated task.

Clearing pending first means stale pending events can't fire on resume (Review Focus 2).

- [ ] **Step 1: Write the failing tests.** In `test_automation_matcher.py`, reuse the session-completion helper the existing run-event test uses (`grep -n "agent.completed\|def _complete\|def _finish" backend/tests/unit/test_automation_matcher.py`). If there isn't one, write `_finish(tasks, sessions, occurrence, status)`: create a session, link it to the occurrence with `tasks.link_session`, and append `{"type": "agent.completed", "status": status, "runId": "r1", "agent": "codex"}` through `sessions.append_event`.

```python
def _fired_occurrence(world, routine):
    tasks, automations, _, clock = world
    automations.enqueue_manual(routine["id"])
    run(world)
    return _occurrences(tasks, routine["id"])[-1]


def test_three_consecutive_failures_pause_with_failing(world):
    tasks, _, _, _ = world
    routine = _automation(tasks, routineTriggers=[])
    for _ in range(3):
        occurrence = _fired_occurrence(world, routine)
        _finish(world, occurrence, "failed")
        tasks.update_task(occurrence["id"], {"status": "done"})
        run(world)
    task = tasks.get_task(routine["id"])
    assert (task["routineState"], task["routinePauseReason"]) == ("paused_by_relay", "failing")


def test_success_resets_failure_count(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineTriggers=[])
    for status in ("failed", "failed", "completed", "failed", "failed"):
        occurrence = _fired_occurrence(world, routine)
        _finish(world, occurrence, status)
        tasks.update_task(occurrence["id"], {"status": "done"})
        run(world)
    assert tasks.get_task(routine["id"])["routineState"] == "active"
    assert automations.get_state(routine["id"])["consecutive_failures"] == 2


def test_human_cancel_does_not_count(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineTriggers=[])
    occurrence = _fired_occurrence(world, routine)
    _finish(world, occurrence, "cancelled")
    run(world)
    assert automations.get_state(routine["id"])["consecutive_failures"] == 0


def test_failures_of_unrelated_sessions_do_not_count(world):
    tasks, automations, _, _ = world
    routine = _automation(tasks, routineTriggers=[])
    plain = tasks.create_task({"title": "plain"})
    _finish(world, plain, "failed")
    run(world)
    assert automations.get_state(routine["id"])["consecutive_failures"] == 0
```

In `test_automation_triggers_api.py`:

```python
def test_resume_clears_pause_pending_and_recomputes_next_run(client, task_store, automation_store):
    task = client.post("/api/v1/tasks", json={"title": "d", "isRoutine": True, "assignedAgentId": AGENT_ID,
                                              "routineState": "active", "routineTriggers": DAILY_9}).json()
    task_store.update_task(task["id"], {"routineState": "paused_by_relay", "routinePauseReason": "failing",
                                        "routineNextRunAt": None})
    automation_store.mark_pending(task["id"], {"eventType": "manual", "depth": 0}, datetime.now(timezone.utc))
    resumed = client.post(f"/api/v1/tasks/{task['id']}/automation/resume").json()
    assert resumed["routineState"] == "active" and "routinePauseReason" not in resumed
    assert resumed["routineNextRunAt"].endswith("T09:00:00+00:00")
    state = automation_store.get_state(task["id"])
    assert state["pending"] is False and state["consecutive_failures"] == 0


def test_resume_by_non_owner_is_403(client, other_client): ...
def test_resume_active_is_noop(client): ...
```

Write the two elided bodies out in full, using the same fixtures as the existing "owner or admin only" Run-now test in that file (`grep -n "403" backend/tests/api/test_automation_triggers_api.py`). Add a `automation_store` fixture there if none exists (`request.app.state.automation_store` via the client's app).

Web test: render `AutomationPauseBanner` with a `paused_by_relay`/`failing` task and `canResume`. It shows the `failing` reason text and a Resume button. Clicking the button calls a mocked `resumeAutomation` with the task id. With `canResume={false}`, there is no button.

- [ ] **Step 2: Run** the three test files. Expected: FAIL.
- [ ] **Step 3: Implement**

```python
    # automation_store.py
    def record_outcome(self, routine_id: str, failed: bool) -> int:
        state = self.get_state(routine_id)
        count = int(state.get("consecutive_failures") or 0) + 1 if failed else 0
        self.save_state(routine_id, {**state, "consecutive_failures": count})
        return count
```

In `AutomationMatcher.drain`, right after `event = self._enrich(row)` and its `None` check:

```python
                if row["kind"] == "run_event" and event.get("originAutomationId"):
                    failed = row["event_type"] == "run.failed"
                    count = self.automation_store.record_outcome(event["originAutomationId"], failed)
                    if failed and count >= FAILURE_LIMIT:
                        self.firing.pause(event["originAutomationId"], "failing",
                                          f"Automation paused: its last {FAILURE_LIMIT} runs failed.")
```

The matcher needs a reference to the `AutomationFiring` instance; `AutomationService` passes it in its constructor. The route:

```python
@router.post("/tasks/{task_id}/automation/resume")
async def resume_automation(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    actor = await run_in_threadpool(request_actor, request, ctx.auth_store)
    task = await run_in_threadpool(get_task_for_actor, ctx.task_store, task_id, actor)
    if not task.get("isRoutine"):
        raise HTTPException(404, "Not an automation.")
    try:
        return await run_in_threadpool(automation_service(request, ctx).resume, task_id, actor, datetime.now(timezone.utc))
    except PermissionError as error:
        raise HTTPException(403, str(error)) from error
```

`automation_service(request, ctx)` is a small factory in `automation_routes.py` that builds the service from `request.app.state.automation_store` and `ctx`, the same way `request_manual_occurrence` builds it. Use it in both places.

Web side:
- The banner gets `canResume` (owner or admin, computed like Run now's permission in `recordActions.ts`) and a Resume button.
- The button calls `resumeAutomation(task.id)`, shows `automation.resumed_toast`, and invalidates the task and automation list queries the same way Run now does.

- [ ] **Step 4: Run** `cd backend && uv run pytest -q && cd ../web && npx vitest run && npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5: Commit** with `git commit -am "feat: pause automations that keep failing and let owners resume them"`, then open PR 3.

---

## Self-review notes

- **Spec coverage:**
  - §1 model: Tasks 7, 8, 9.
  - §2 firing: the clock is Task 10; matcher, coalescing, the rate-cap exemption, no-target, and Run now are Task 11; auto-pause is Task 15.
  - §3 structure: Tasks 2–5 and 10; the API is Task 12, the web Task 13, and croniter Task 6.
  - §4 errors: field-path 400s in Tasks 6, 7, and 12; the invalid-schedule pause and the one-transaction clock test in Task 10.
  - §5 testing: covered per task, with the integration test in Task 10 Step 4.
  - §6 delivery: the PR split.
- **Type consistency:**
  - `create_triggered_occurrence(..., allow_paused=)` is introduced in Task 11; the `fire_now` helper (Task 10) notes the ordering.
  - `AutomationService.tick` takes `today: date` in PR 1 (Task 4) and `now: datetime` from Task 10 on. That change is deliberate, and Task 10 rewires the scheduler.
  - The wire type `RoutineState` and the list type `RoutineListState` have distinct names from Task 13 on.
  - `AutomationFiring.pause` is public from Task 11 and used by Task 15.
