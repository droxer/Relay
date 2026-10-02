# Automation Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename Routines to Automations in the product, and let an automation fire on Relay task/run events and inbound webhooks, not only on a schedule.

**Architecture:** An automation stays a routine task record with a new `routineTrigger` field. Task and session stores write a transactional `automation_outbox` row for trigger-eligible events; a matcher in the scheduler tick drains it, coalesces matches per automation, and promotes an occurrence through a new `create_triggered_occurrence` store method. The existing daemon dispatch path runs it.

**Tech Stack:** Python 3.12 / FastAPI / SQLAlchemy / Alembic / pytest (backend); Next.js / React / TanStack Query / i18next / `node:test` (web).

**Spec:** `docs/automation-triggers-design.md`

## Implementation status (2026-10-02)

- Tasks 1–7 were committed before the continuation.
- Tasks 8–11 are implemented: transactional matching and coalescing, scheduler
  wiring, authenticated webhooks, trigger forms and filters, one-time secrets,
  run labels, and English/Chinese strings.
- Task 12 local validation is complete and recorded in `docs/testing/automation-triggers.tdd.md`.
  The migration chain requires PostgreSQL; SQLite cannot run its first migration.
- Additional regressions cover rollback after interrupted firing, concurrent
  schedulers, empty webhook bodies, and labels on scheduled/manual occurrences.
- PR publication remains outside this local implementation; a review packet
  accompanies the evidence report.


## Global Constraints

- The backend never executes agents; triggers only create occurrences that `_dispatch_assigned_tasks` dispatches.
- The event log is authoritative: trigger config lives on `task.created` / `task.updated` events and replays into the snapshot.
- Storage and wire names stay `routine*`; only user-facing text and URLs say "automation".
- A missing `routineTrigger` reads as `{"kind": "schedule"}`; no data migration of existing routines.
- `MAX_AUTOMATION_DEPTH = 3`; pending events cap 20; webhook body ≤ 64 KB; webhook payload in context ≤ 8 KB; `RELAY_AUTOMATION_MAX_RUNS_PER_HOUR` default 6; `RELAY_AUTOMATION_OUTBOX_BATCH` default 200; stale claim 5 min; outbox prune 7 days; pending drop 24 h.
- Webhook auth header `X-Relay-Automation-Token`; never accept the secret in the URL; store SHA-256 hex only; plaintext returned once.
- zh-CN uses 自动化 (count form 个自动化). Every user-facing string lands in both `en` and `zh-CN`.
- Immutability: snapshots and form state are replaced, never mutated in place.

## Deviations from the spec (found while reading the code)

1. **"Run now" already exists** (`POST /api/v1/tasks/{id}/runs`, `record.run_now` button). No new run endpoint or note field; the existing one keeps working for every trigger kind.
2. **Outbox is database-only.** Production builds only `DatabaseTaskStore`/`DatabaseSessionStore`; `Local*Store` are test fixtures and write no outbox rows.
3. **Status changes come from `task.status` events**, detected by diffing the snapshot before/after a write, not from `task.updated`.
4. **Triggered occurrences need a new store method.** `create_routine_occurrence` dedupes by date, so it would return the morning's occurrence for an afternoon event.
5. **`fileExtension` filter dropped.** `agent.completed` carries no file list and artifact indexing order is not guaranteed; out of v1.
6. **No `RELAY_AUTOMATION_TRIGGERS_ENABLED` flag.** It was default-on and the only capability endpoint (`GET /admin/settings`) is admin-only; employees edit automations too.
7. **Webhook to an unknown routine answers 401, not 404**, so the endpoint does not reveal which ids exist.
8. **"In flight" for coalescing is `backlog | assigned | running`.** An occurrence parked in review/blocked/waiting_for_human must not hold events forever.
9. **New routine state `listening`** for enabled non-schedule automations; otherwise every event automation shows as "Unscheduled".
10. **The list's "Next run" column becomes "Trigger"**: schedule rows keep the date cell; other rows show the trigger label. No extra column.
11. **`automations` joins `WEB_UI_ROUTE_ROOTS`** so a hard refresh on `/automations/...` serves the SPA.

## Review Focus

1. An automation's own occurrence changing status must never fire that automation (self-loop), even via a chain ≤ depth 3 → Task 8 test `test_own_occurrence_never_refires`.
2. A burst arriving while the last occurrence sits in `review`/`blocked` must still fire → Task 8 test `test_parked_occurrence_does_not_hold_events`.
3. A webhook to a paused automation answers 409 and queues nothing; re-enabling does not replay old calls → Task 9 test `test_webhook_to_paused_automation_is_refused`.
4. Switching an automation schedule → webhook clears `routineNextRunDate` so the scheduler stops firing it; switching back recomputes it → Task 5 test `test_switching_trigger_kind_moves_next_run`.
5. An automation deleted with outbox rows and pending state left behind must not crash the tick → Task 8 test `test_deleted_automation_clears_pending_state`.

## How to run things

- Web tests: `npx tsc -p packages/tsconfig.json && node --test dist/web/tests/<name>.test.js` (from repo root, ~3 s).
- Web typecheck/lint: `npm run lint -w web` and `npx tsc -p web/tsconfig.json --noEmit`.
- Backend tests: `cd backend && UV_CACHE_DIR=../.uv-cache uv run --extra dev pytest tests/<path> -q`.
- Full suite at the end: `npm test`.

---

# Phase 1 — Rename Routines → Automations (one PR)

### Task 1: Routes and redirects

**Files:**
- Modify: `web/src/lib/appRoute.ts` (WORK_PATHS, PATH_HEAD_ALIASES, pathForAppState, canonicalBrowserUrl)
- Modify: `backend/relay/api/contract.py:13-27` (WEB_UI_ROUTE_ROOTS)
- Test: `web/tests/appRoute.test.ts`, `backend/tests/api/test_url_contract.py`

**Interfaces:**
- Produces: `/automations[/<id>[/runs/<runId>]]` as the written URL; `/routines/...` still parses and is rewritten by `canonicalBrowserUrl`. Internal route id stays `"routine"`; internal path head stays `"routines"` so every `head === "routines"` branch is untouched.

- [ ] **Step 1: Update and add web route tests.** In `web/tests/appRoute.test.ts`, change every expected `/routines` output to `/automations` (the `hrefForRoute("routine")` assertion; the `canonicalBrowserUrl("/routines", ...)` assertions keep their input but expect `/automations...`; the `browserUrlForAppState` record-drawer assertions expect `/automations/R-42...`). In the path→route table add `"/automations": "routine"` beside `"/routines": "routine"`. Add:

```ts
it("redirects the retired /routines paths to /automations", () => {
  assert.equal(canonicalBrowserUrl("/routines"), "/automations");
  assert.equal(canonicalBrowserUrl("/routines", "?sort=title"), "/automations?sort=title");
  assert.equal(canonicalBrowserUrl("/routines/R-42", "?tab=definition"), "/automations/R-42?tab=definition");
  assert.equal(canonicalBrowserUrl("/routines/R-42/runs/T-9"), "/automations/R-42/runs/T-9");
  assert.deepEqual(parseAppPath("/routines/R-42"), parseAppPath("/automations/R-42"));
  assert.deepEqual(parseAppPath("/routines/R-42/runs/T-9"), parseAppPath("/automations/R-42/runs/T-9"));
  // Issues keeps its own read-only alias and is not rewritten.
  assert.equal(canonicalBrowserUrl("/backlog"), "/backlog");
});
```

- [ ] **Step 2: Run, expect FAIL.** `npx tsc -p packages/tsconfig.json && node --test dist/web/tests/appRoute.test.js`.

- [ ] **Step 3: Implement in `web/src/lib/appRoute.ts`.**

```ts
const WORK_PATHS: Record<Exclude<AppRoute, "main" | "projects">, string> = {
  backlog: "/issues",
  routine: "/automations",
  // ...rest unchanged
};

/* Both routes keep their old heads inside the app; only their addresses
   changed (/issues, /automations). Folding the new head back keeps every
   `head === "backlog"` / `head === "routines"` branch below meaning one
   thing, and old links land on the same page. */
const PATH_HEAD_ALIASES: Record<string, string> = { issues: "backlog", automations: "routines" };
WORK_ROUTES.set("/backlog", "backlog");
WORK_ROUTES.set("/routines", "routine");
```

In `pathForAppState`:

```ts
  if (route === "routine" && taskId) {
    const routinePath = `${WORK_PATHS.routine}/${encodeURIComponent(taskId)}`;
    return runId ? `${routinePath}/runs/${encodeURIComponent(runId)}` : routinePath;
  }
```

Replace `canonicalBrowserUrl`:

```ts
/* Heads renamed in the product but still linked from old threads and
   bookmarks. Unlike PATH_HEAD_ALIASES (read-only), these rewrite the address
   bar on arrival. /backlog is deliberately absent: its tests pin it. */
const RENAMED_PATH_HEADS: Readonly<Record<string, string>> = { routines: "automations" };

function canonicalPathname(pathname: string): string {
  const match = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const renamed = match ? RENAMED_PATH_HEADS[match[1]] : undefined;
  return renamed ? `/${renamed}${match?.[2] ?? ""}` : pathname;
}

export function canonicalBrowserUrl(pathname: string, search = ""): string {
  return `${canonicalPathname(pathname)}${canonicalSearchForPath(pathname, search)}`;
}
```

Update the `taskId` doc comment to `/automations/<id>`. Then `grep -rn '"/routines\|/routines/' web/src web/e2e web/interaction-tests script` and change any remaining literal hrefs (expected: none outside appRoute).

- [ ] **Step 4: Run, expect PASS.** Same command, plus `node --test dist/web/tests/taskRecordRoute.test.js dist/web/tests/sharedThread.test.js`; update any `/routines` expectation there the same way.

- [ ] **Step 5: Backend SPA root.** Add `"automations",` to `WEB_UI_ROUTE_ROOTS`. In `test_spa_fallback_is_allowlisted_and_never_masks_api_typos` add `"/automations"` and `"/automations/R-1"` to the browser-route tuple. Run `pytest tests/api/test_url_contract.py -q` → PASS.

- [ ] **Step 6: Commit.** `git add web/src/lib/appRoute.ts web/tests backend/relay/api/contract.py backend/tests/api/test_url_contract.py && git commit -m "feat(web): move Routines to /automations with redirects"`

### Task 2: Label text (en + zh-CN) and guard test

**Files:**
- Modify: `web/src/i18n/locales/en/translation.json`, `web/src/i18n/locales/zh-CN/translation.json`
- Create: `web/tests/automationLabels.test.ts`

**Interfaces:** Keys unchanged; only values change. Later tasks must not add values containing "routine"/例行.

- [ ] **Step 1: Write the guard test** `web/tests/automationLabels.test.ts`:

```ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it } from "node:test";

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix = ""): Array<[string, string]> {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === "string" ? [[prefix + key, value] as [string, string]] : flatten(value, `${prefix}${key}.`),
  );
}

/* The feature is "Automations" wherever a reader sees it; `routine*` survives
   only as a storage and wire name. "routine updates" on the login page is
   plain English, not the feature. */
const RETIRED = /routine|例行/i;
const PLAIN_ENGLISH = new Set(["login.do_handoff"]);

describe("Automation labels", () => {
  for (const locale of ["en", "zh-CN"]) {
    it(`never says routine in ${locale}`, () => {
      const tree = JSON.parse(readFileSync(resolve(`web/src/i18n/locales/${locale}/translation.json`), "utf8")) as Tree;
      const offenders = flatten(tree)
        .filter(([key, value]) => !PLAIN_ENGLISH.has(key) && RETIRED.test(value))
        .map(([key, value]) => `${key}: ${value}`);
      assert.deepEqual(offenders, []);
    });
  }
});
```

- [ ] **Step 2: Run, expect FAIL** (~32 offenders per locale): `npx tsc -p packages/tsconfig.json && node --test dist/web/tests/automationLabels.test.js`.

- [ ] **Step 3: Edit the values** exactly as the two "Label text" tables in `docs/automation-triggers-design.md` §4 give them, in both files. Plural pairs: en `_one` singular / `_other` plural; zh-CN identical. Full values for the rows the spec abbreviates:
  - `project.delete_confirm_message` en: `This permanently deletes all project issues, automations, conversations, and artifacts, and queues deletion of its workspace files when its computer connects. This cannot be undone. Shared agents and the computer are kept.` zh-CN: `这将永久删除项目的所有议题、自动化、对话和产物，并在所属电脑连接后删除工作区文件。此操作无法撤销。共享的智能体和电脑会保留。`
  - `routine.bulk_delete_body_one` en: `1 selected automation and its trigger will be deleted. It will not run again. All associated occurrences and threads will also be deleted. This cannot be undone.` `_other` en: `{{count}} selected automations and their triggers will be deleted. They will not run again. All associated occurrences and threads will also be deleted. This cannot be undone.` zh-CN (both): `将删除所选的 {{count}} 个自动化及其触发器，并且不会再次运行。所有关联的执行记录和话题也将一并删除。此操作无法撤销。`

- [ ] **Step 4: Run, expect PASS** — guard test plus `node --test dist/web/tests/i18nPlurals.test.js`.

- [ ] **Step 5: Commit.** `git add web/src/i18n web/tests/automationLabels.test.ts && git commit -m "feat(web): call Routines Automations in en and zh-CN"`

### Task 3: Docs

**Files:** Modify `README.md`, `docs/api.md`, `docs/deployment.md`, `CLAUDE.md`.

- [ ] **Step 1:** In `README.md`, `docs/api.md`, `docs/deployment.md`, change prose naming the UI feature ("Routines", "recurring routines") to "Automations"; leave API fields (`routineType`, …) and endpoint paths alone. In `docs/api.md` next to the routine fields add: `Automations are stored as routine tasks; the routine* field names are the wire names.`
- [ ] **Step 2:** In `CLAUDE.md` → "Key invariants", add:

```markdown
- **Automations are routines on the wire.** The product says Automations (`/automations`, every label), but tasks, events, columns, and API fields keep `routine*` names, like `daemon-node`. `routineTrigger` (schedule, task_event, run_event, webhook, manual) says what fires one; event and webhook firings flow through the transactional `automation_outbox` and `relay/automations/matcher.py`, never through a second dispatch path.
```

- [ ] **Step 3:** If `script/readme-snapshots` captures the Routines page, re-run it per its README; otherwise note "no snapshot affected" in the PR.
- [ ] **Step 4: Commit.** `git commit -am "docs: describe Automations"`

---

# Phase 2 — Backend triggers

### Task 4: Trigger model (pure)

**Files:**
- Create: `backend/relay/automations/__init__.py` (empty), `backend/relay/automations/trigger.py`
- Test: `backend/tests/unit/test_automation_trigger.py`

**Interfaces:**
- Produces: `TriggerError(ValueError)`; `normalize_trigger(raw: Any) -> dict`; `trigger_of(task: dict) -> dict`; `trigger_kind(task: dict) -> str`; `event_matches(trigger: dict, event: dict) -> bool`; `trigger_context_block(events: list[dict], dropped: int = 0) -> str`; constants `TRIGGER_KINDS`, `EVENT_KINDS = ("task_event", "run_event")`, `SCHEDULE_TRIGGER`.
- Enriched event shape (used by Task 8): `{"eventType": "task.created"|"task.status_changed"|"run.completed"|"run.failed"|"webhook", "subject": {id,title,status,priority,projectId,assignedAgentId,assignedTeamId}, "fromStatus"?, "toStatus"?, "sessionId"?, "error"?, "payload"? (webhook), "originAutomationId"?, "depth": int}`.

- [ ] **Step 1: Write failing tests** `backend/tests/unit/test_automation_trigger.py`:

```python
from __future__ import annotations

import pytest
from relay.automations.trigger import (
    TriggerError, event_matches, normalize_trigger, trigger_context_block, trigger_kind,
)


def test_schedule_and_webhook_take_no_options() -> None:
    assert normalize_trigger({"kind": "schedule"}) == {"kind": "schedule"}
    assert normalize_trigger({"kind": "webhook"}) == {"kind": "webhook"}
    with pytest.raises(TriggerError):
        normalize_trigger({"kind": "webhook", "on": "created"})


@pytest.mark.parametrize("raw", [
    None, "schedule", {"kind": "cron"}, {"kind": "task_event"},
    {"kind": "task_event", "on": "completed"},
    {"kind": "run_event", "on": "failed", "filters": {"toStatus": "done"}},
    {"kind": "task_event", "on": "created", "filters": {"fromStatus": "running"}},
    {"kind": "task_event", "on": "created", "filters": {"unknown": 1}},
    {"kind": "task_event", "on": "created", "filters": {"titleContains": "x" * 121}},
    {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "failed"}},
    {"kind": "schedule", "extra": True},
])
def test_rejects_malformed_triggers(raw) -> None:
    with pytest.raises(TriggerError):
        normalize_trigger(raw)


def test_drops_empty_filters_and_trims_title() -> None:
    assert normalize_trigger({
        "kind": "task_event", "on": "status_changed",
        "filters": {"toStatus": "blocked", "projectId": "", "titleContains": "  nightly "},
    }) == {"kind": "task_event", "on": "status_changed",
           "filters": {"toStatus": "blocked", "titleContains": "nightly"}}


def test_missing_trigger_reads_as_schedule() -> None:
    assert trigger_kind({}) == "schedule"
    assert trigger_kind({"routineTrigger": {"kind": "bogus"}}) == "schedule"
    assert trigger_kind({"routineTrigger": {"kind": "webhook"}}) == "webhook"


def _status_event(**subject) -> dict:
    return {"eventType": "task.status_changed", "fromStatus": "running", "toStatus": "blocked",
            "subject": {"id": "T-1", "title": "Nightly import", "priority": "high", **subject}, "depth": 0}


def test_event_matches_kind_on_and_every_filter() -> None:
    trigger = {"kind": "task_event", "on": "status_changed",
               "filters": {"toStatus": "blocked", "projectId": "p1", "titleContains": "IMPORT"}}
    assert event_matches(trigger, _status_event(projectId="p1"))
    assert not event_matches(trigger, _status_event(projectId="p2"))
    assert not event_matches({**trigger, "on": "created"}, _status_event(projectId="p1"))
    assert not event_matches({"kind": "webhook"}, _status_event())


def test_context_block_lists_events_and_dropped_count() -> None:
    block = trigger_context_block([_status_event(), _status_event()], dropped=1)
    assert block.splitlines()[:3] == ["---", "Trigger context", "Fired by: Task status changed (3 events, 1 not listed)"]
    assert '- Task T-1 "Nightly import" — running → blocked' in block


def test_context_block_truncates_webhook_payload() -> None:
    block = trigger_context_block([{"eventType": "webhook", "payload": {"blob": "x" * 20000}, "depth": 0}])
    assert "(truncated)" in block
    assert len(block.encode()) < 9 * 1024
```

- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError: relay.automations`): `pytest tests/unit/test_automation_trigger.py -q`.

- [ ] **Step 3: Implement** `backend/relay/automations/trigger.py`:

```python
"""What starts an automation, and whether an event is one of its starts.

An automation is still a routine task record; ``routineTrigger`` on it says
what fires it. Everything here is pure so the API, the store replay, and the
matcher read a trigger the same way.
"""

from __future__ import annotations

import json
from typing import Any

TRIGGER_KINDS = ("schedule", "task_event", "run_event", "webhook", "manual")
EVENT_KINDS = ("task_event", "run_event")
TRIGGER_ON = {
    "task_event": ("created", "status_changed"),
    "run_event": ("completed", "failed"),
}
EVENT_TYPES = {
    ("task_event", "created"): "task.created",
    ("task_event", "status_changed"): "task.status_changed",
    ("run_event", "completed"): "run.completed",
    ("run_event", "failed"): "run.failed",
}
SCHEDULE_TRIGGER: dict[str, Any] = {"kind": "schedule"}
SCOPE_FILTERS = ("projectId", "assignedAgentId", "assignedTeamId")
FILTER_KEYS = (*SCOPE_FILTERS, "fromStatus", "toStatus", "priority", "titleContains")
TASK_STATUSES = ("backlog", "assigned", "running", "waiting_for_human", "review", "done", "blocked")
TASK_PRIORITIES = ("low", "normal", "high")
TITLE_CONTAINS_MAX = 120
ID_MAX = 200
WEBHOOK_PAYLOAD_LIMIT = 8 * 1024
EVENT_LABELS = {
    "task.created": "Task created",
    "task.status_changed": "Task status changed",
    "run.completed": "Run completed",
    "run.failed": "Run failed",
    "webhook": "Webhook",
}


class TriggerError(ValueError):
    """A trigger the API refuses with a 400."""


def normalize_trigger(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise TriggerError("routineTrigger must be an object.")
    unknown = set(raw) - {"kind", "on", "filters"}
    if unknown:
        raise TriggerError(f"routineTrigger has unknown keys: {', '.join(sorted(unknown))}.")
    kind = raw.get("kind")
    if kind not in TRIGGER_KINDS:
        raise TriggerError(f"routineTrigger.kind must be one of: {', '.join(TRIGGER_KINDS)}.")
    if kind not in TRIGGER_ON:
        if raw.get("on") is not None or raw.get("filters"):
            raise TriggerError(f"A {kind} trigger takes no on or filters.")
        return {"kind": kind}
    on = raw.get("on")
    if on not in TRIGGER_ON[kind]:
        raise TriggerError(f"routineTrigger.on for {kind} must be one of: {', '.join(TRIGGER_ON[kind])}.")
    filters = _normalize_filters(on, raw.get("filters") or {})
    return {"kind": kind, "on": on, **({"filters": filters} if filters else {})}


def _normalize_filters(on: str, raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        raise TriggerError("routineTrigger.filters must be an object.")
    unknown = set(raw) - set(FILTER_KEYS)
    if unknown:
        raise TriggerError(f"routineTrigger.filters has unknown keys: {', '.join(sorted(unknown))}.")
    present = {key: value for key, value in raw.items() if value not in (None, "")}
    if ("fromStatus" in present or "toStatus" in present) and on != "status_changed":
        raise TriggerError("fromStatus and toStatus apply only to status_changed.")
    filters: dict[str, str] = {}
    for key, value in present.items():
        if key in SCOPE_FILTERS:
            if not isinstance(value, str) or len(value) > ID_MAX:
                raise TriggerError(f"filters.{key} must be an id.")
            filters[key] = value
        elif key in ("fromStatus", "toStatus"):
            if value not in TASK_STATUSES:
                raise TriggerError(f"filters.{key} must be a task status.")
            filters[key] = value
        elif key == "priority":
            if value not in TASK_PRIORITIES:
                raise TriggerError("filters.priority must be low, normal, or high.")
            filters[key] = value
        else:
            title = value.strip() if isinstance(value, str) else ""
            if not title or len(value) > TITLE_CONTAINS_MAX:
                raise TriggerError(f"filters.titleContains must be 1–{TITLE_CONTAINS_MAX} characters.")
            filters[key] = title
    return filters


def trigger_of(task: dict[str, Any]) -> dict[str, Any]:
    trigger = task.get("routineTrigger")
    if isinstance(trigger, dict) and trigger.get("kind") in TRIGGER_KINDS:
        return trigger
    return SCHEDULE_TRIGGER


def trigger_kind(task: dict[str, Any]) -> str:
    return str(trigger_of(task)["kind"])


def event_matches(trigger: dict[str, Any], event: dict[str, Any]) -> bool:
    expected = EVENT_TYPES.get((trigger.get("kind"), trigger.get("on")))
    if expected is None or expected != event.get("eventType"):
        return False
    filters = trigger.get("filters") or {}
    subject = event.get("subject") or {}
    for key in (*SCOPE_FILTERS, "priority"):
        if key in filters and subject.get(key) != filters[key]:
            return False
    if "fromStatus" in filters and event.get("fromStatus") != filters["fromStatus"]:
        return False
    if "toStatus" in filters and event.get("toStatus") != filters["toStatus"]:
        return False
    title = filters.get("titleContains")
    return not title or title.lower() in str(subject.get("title") or "").lower()


def trigger_context_block(events: list[dict[str, Any]], dropped: int = 0) -> str:
    label = EVENT_LABELS.get(events[0]["eventType"], events[0]["eventType"])
    total = len(events) + dropped
    if total > 1:
        label = f"{label} ({total} events" + (f", {dropped} not listed" if dropped else "") + ")"
    lines = ["---", "Trigger context", f"Fired by: {label}"]
    lines.extend(f"- {_event_line(event)}" for event in events)
    return "\n".join(lines)


def _event_line(event: dict[str, Any]) -> str:
    subject = event.get("subject") or {}
    task = f'Task {subject["id"]} "{subject.get("title", "")}"' if subject.get("id") else ""
    event_type = event["eventType"]
    if event_type == "task.status_changed":
        return f"{task} — {event.get('fromStatus')} → {event.get('toStatus')}"
    if event_type == "task.created":
        return f"{task} — created"
    if event_type in ("run.completed", "run.failed"):
        outcome = "completed" if event_type == "run.completed" else "failed"
        where = task or f"Thread {event.get('sessionId')}"
        detail = f": {event['error']}" if event.get("error") else ""
        return f"{where} — run {outcome}{detail}"
    payload = json.dumps(event.get("payload"), ensure_ascii=False, sort_keys=True)
    encoded = payload.encode()
    if len(encoded) > WEBHOOK_PAYLOAD_LIMIT:
        payload = encoded[:WEBHOOK_PAYLOAD_LIMIT].decode(errors="ignore") + " …(truncated)"
    return f"Webhook payload (JSON):\n{payload}"
```

- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit.** `git add backend/relay/automations backend/tests/unit/test_automation_trigger.py && git commit -m "feat(backend): add automation trigger model"`

### Task 5: Persist `routineTrigger` on routines

**Files:**
- Modify: `backend/relay/persistence/store_common.py` (`_apply_task_routine_fields`, task.created materialization ~L574)
- Modify: `backend/relay/persistence/task_store.py` (`task_creation_events`, `task_update_events`, `routine_due_for_promotion`, `tasks` table, `task_to_row`)
- Create: `backend/migrations/versions/20261002_0081_routine_trigger_kind.py`
- Modify: `backend/relay/api/task_routes.py` (`routine_fields`, `create_task`, `update_task`)
- Test: `backend/tests/api/test_automation_triggers_api.py`

**Interfaces:**
- Produces on task snapshots: `routineTrigger` (normalized dict; absent = schedule), `routineDisabledReason` (string, cleared on re-enable), occurrence stamps `routineTriggerKind`, `routineTriggerDepth`. DB column `tasks.routine_trigger_kind`.
- `routine_fields(...)` also returns `routineTrigger` when the body supplied one.

- [ ] **Step 1: Write failing API tests** `backend/tests/api/test_automation_triggers_api.py`:

```python
from __future__ import annotations

from datetime import date
from tempfile import TemporaryDirectory

from fastapi.testclient import TestClient
from relay.app import create_app

from test_tasks import _bootstrap_admin, _create_agent, _create_user

WEBHOOK = {"kind": "webhook"}
ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


def _client(monkeypatch, root: str) -> tuple[TestClient, dict]:
    monkeypatch.setenv("RELAY_ADMIN_TOKEN", "admin_token")
    monkeypatch.setenv("RELAY_TASK_SCHEDULER_ENABLED", "0")
    client = TestClient(create_app(root))
    _bootstrap_admin(client)
    _create_user(client, "alice", employee_id="alice")
    return client, _create_agent(client, "alice")


def _routine(client: TestClient, agent: dict, **extra) -> dict:
    response = client.post("/api/v1/tasks", json={
        "title": "Triage failures", "description": "Look into it.",
        "ownerEmployeeId": "alice", "assigneeEmployeeId": "alice",
        "assignedAgentId": agent["id"], "isRoutine": True, "routineEnabled": True,
        "routineCadence": "weekly", **extra,
    })
    assert response.status_code == 201, response.text
    return response.json()


def test_event_trigger_round_trips_and_clears_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent, routineTrigger=ON_BLOCKED)
        assert created["routineTrigger"] == ON_BLOCKED
        assert "routineNextRunDate" not in created
        assert client.app.state.task_store.list_due_routines("2099-01-01") == []


def test_routine_without_trigger_reads_as_schedule(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        assert "routineTrigger" not in created
        assert created["routineNextRunDate"]


def test_switching_trigger_kind_moves_next_run(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        created = _routine(client, agent)
        to_webhook = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": WEBHOOK})
        assert to_webhook.status_code == 200, to_webhook.text
        assert "routineNextRunDate" not in to_webhook.json()
        back = client.patch(f"/api/v1/tasks/{created['id']}", json={"routineTrigger": {"kind": "schedule"}})
        assert back.json()["routineTrigger"] == {"kind": "schedule"}
        assert back.json()["routineNextRunDate"] > date.today().isoformat()


def test_invalid_trigger_is_a_400(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        response = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "routineTrigger": {"kind": "task_event", "on": "completed"},
        })
        assert response.status_code == 400
        missing = client.post("/api/v1/tasks", json={
            "title": "Bad", "isRoutine": True, "assignedAgentId": agent["id"],
            "routineTrigger": {"kind": "task_event", "on": "created", "filters": {"projectId": "nope"}},
        })
        assert missing.status_code == 400
        assert "projectId" in missing.json()["detail"]
```

(If `create_task` rejects a projectless routine, create a project with `project_for_agents(app.state.project_store, "alice", [agent])` from `issue_projects` and pass `"projectId"` in `_routine`, following `test_task_create_update_and_retired_claim_next`. `ctx.today()` drives next-run math; if a test pins `RELAY_TASK_SCHEDULER_TODAY`-style env, compare against that instead of `date.today()`.)

- [ ] **Step 2: Run, expect FAIL.** `pytest tests/api/test_automation_triggers_api.py -q`.

- [ ] **Step 3: Replay fields** in `store_common.py`. In `_apply_task_routine_fields`, inside the `not task["isRoutine"]` early-return block also `task.pop("routineTrigger", None)` and `task.pop("routineDisabledReason", None)`. After the `routineEnabled` block add:

```python
    if event.get("routineEnabled") is True:
        task.pop("routineDisabledReason", None)
    if "routineDisabledReason" in event and event["routineDisabledReason"] is not None:
        if event["routineDisabledReason"]:
            task["routineDisabledReason"] = event["routineDisabledReason"]
        else:
            task.pop("routineDisabledReason", None)
    if isinstance(event.get("routineTrigger"), dict):
        task["routineTrigger"] = dict(event["routineTrigger"])
```

In the task.created materialization next to `scheduledFor`:

```python
    if created.get("routineTriggerKind"):
        task["routineTriggerKind"] = created["routineTriggerKind"]
    if "routineTriggerDepth" in created:
        task["routineTriggerDepth"] = int(created["routineTriggerDepth"] or 0)
```

- [ ] **Step 4: Event builders** in `task_store.py`: add `"routineTrigger"` and `"routineTriggerKind"` to the truthy-copied tuple in `task_creation_events`; add `"routineTriggerDepth"` to the `in payload` tuple beside `isRoutine`/`routineEnabled`. Add `"routineTrigger"` and `"routineDisabledReason"` to the `task_update_events` field tuple. In `routine_due_for_promotion` first line: `if trigger_kind(routine) != "schedule": return False` (import from `..automations.trigger`).

- [ ] **Step 5: Column.** In the `tasks` Table add `Column("routine_trigger_kind", Text, nullable=True),` after `routine_enabled` and `Index("ix_tasks_routine_trigger_kind", "routine_trigger_kind"),`. In `task_to_row` add `"routine_trigger_kind": trigger_kind(task) if task.get("isRoutine") else None,`. Migration:

```python
"""Index what fires each automation so the matcher can list event automations."""

from alembic import op
import sqlalchemy as sa

revision = "20261002_0081"
down_revision = "20260924_0080"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("tasks", sa.Column("routine_trigger_kind", sa.Text(), nullable=True))
    op.create_index("ix_tasks_routine_trigger_kind", "tasks", ["routine_trigger_kind"])
    # Every routine before this revision ran on a schedule.
    op.execute("UPDATE tasks SET routine_trigger_kind = 'schedule' WHERE is_routine")


def downgrade() -> None:
    op.drop_index("ix_tasks_routine_trigger_kind", table_name="tasks")
    op.drop_column("tasks", "routine_trigger_kind")
```

Run the schema-drift test if one exists (`grep -rln "target_metadata" backend/tests`) and make it pass.

- [ ] **Step 6: API.** In `routine_fields` add `"routineTrigger"` to the `has_routine_input` tuple, then before `has_next_run_input`:

```python
    trigger = None
    if "routineTrigger" in body:
        try:
            trigger = normalize_trigger(body["routineTrigger"])
        except TriggerError as error:
            raise HTTPException(400, str(error)) from error
    scheduled = (trigger or trigger_of(current or {}))["kind"] == "schedule"
    became_scheduled = bool(current and trigger and scheduled and trigger_kind(current) != "schedule")
```

Guard the auto-next-run block with `next_is_routine and scheduled and resolved_cadence != "custom" and (... or became_scheduled)`; guard the custom-date 400 with `scheduled and`. After `effective_next_run` add `if not scheduled: next_run = ""`. Add `**({"routineTrigger": trigger} if trigger else {})` to the returned dict. Add:

```python
def validate_trigger_scope(ctx: AppContext, trigger: dict[str, Any] | None) -> None:
    """A filter that names a record must name one that exists."""
    filters = (trigger or {}).get("filters") or {}
    lookups = (
        ("projectId", ctx.project_store.get_project),
        ("assignedAgentId", ctx.agent_store.get_agent),
        ("assignedTeamId", ctx.team_store.get_team),
    )
    for key, lookup in lookups:
        if key in filters and not lookup(filters[key]):
            raise HTTPException(400, f"routineTrigger filters.{key} does not exist.")
```

Call `validate_trigger_scope(ctx, routine.get("routineTrigger"))` right after `routine = routine_fields(...)` in `create_task` and `update_task` (wrap lookups that raise `KeyError`).

- [ ] **Step 7: Run, expect PASS.** Then `pytest tests/api/test_tasks.py tests/unit/test_task_store.py tests/unit/test_task_scheduler.py -q` → PASS.
- [ ] **Step 8: Commit.** `git add -A backend && git commit -m "feat(backend): persist automation triggers on routines"`

### Task 6: Automation store and transactional outbox

**Files:**
- Create: `backend/relay/persistence/automation_store.py`, `backend/migrations/versions/20261002_0082_automation_outbox.py`
- Modify: `backend/relay/persistence/schema.py`, `backend/relay/persistence/task_store.py` (`DatabaseTaskStore.create_task`, `_append_events_once`), `backend/relay/persistence/session_store.py` (`DatabaseSessionStore._append_event_once`)
- Test: `backend/tests/unit/test_automation_outbox.py`

**Interfaces:**
- Produces: `subject_of(task) -> dict`; `task_outbox_rows(before: dict | None, after: dict) -> list[dict]`; `session_outbox_rows(session_id: str, event: dict) -> list[dict]`; `insert_outbox_rows(conn, rows) -> None`; `DatabaseAutomationStore(database_url, *, create_schema=False)` with `enqueue_webhook(routine_id, payload)`, `claim_outbox(limit: int, now: datetime) -> list[dict]`, `delete_outbox(ids)`, `prune_outbox(before: datetime) -> int`, `get_state(routine_id) -> dict`, `save_state(routine_id, state)`, `clear_state(routine_id)`, `list_pending_states() -> list[dict]`, `set_webhook_secret(routine_id) -> str`, `verify_webhook_secret(routine_id, token) -> bool`, `has_webhook_secret(routine_id) -> bool`, `delete_webhook_secret(routine_id)`.
- Outbox row: `{"id","kind","event_type","source_type","source_id","target_routine_id","payload","origin_automation_id","depth","created_at"}`. Webhook rows carry `payload = {"body": <json>}`.
- State: `{"routine_id","pending","pending_events","pending_dropped","pending_since","fired_window_start","fired_count"}`.

- [ ] **Step 1: Write failing tests** `backend/tests/unit/test_automation_outbox.py`:

```python
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from tempfile import TemporaryDirectory

from relay.persistence.automation_store import DatabaseAutomationStore
from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.store_common import relay_event
from relay.persistence.task_store import DatabaseTaskStore

NOW = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)


def _stores(root: str):
    url = f"sqlite:///{root}/relay.db"
    return (DatabaseTaskStore(url, create_schema=True), DatabaseSessionStore(url, create_schema=True),
            DatabaseAutomationStore(url, create_schema=True))


def test_task_create_and_status_change_write_outbox_rows() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        task = tasks.create_task({"title": "Import", "priority": "high"})
        tasks.update_task(task["id"], {"status": "blocked", "blockerReason": "stuck"})
        rows = automations.claim_outbox(10, NOW)
        assert [row["event_type"] for row in rows] == ["task.created", "task.status_changed"]
        assert rows[1]["payload"]["from"] == "backlog"
        assert rows[1]["payload"]["to"] == "blocked"
        assert rows[1]["payload"]["subject"]["title"] == "Import"


def test_routine_definitions_and_plain_edits_write_nothing() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        routine = tasks.create_task({"title": "Weekly", "isRoutine": True, "routineEnabled": False})
        tasks.update_task(routine["id"], {"title": "Weekly report"})
        assert automations.claim_outbox(10, NOW) == []


def test_occurrence_status_change_carries_loop_provenance() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        occurrence = tasks.create_task({"title": "Run", "sourceRoutineId": "R-1", "routineTriggerDepth": 1})
        assert automations.claim_outbox(10, NOW) == []
        tasks.update_task(occurrence["id"], {"status": "blocked", "blockerReason": "x"})
        [row] = automations.claim_outbox(10, NOW)
        assert row["origin_automation_id"] == "R-1"
        assert row["depth"] == 2


def test_run_completion_writes_run_rows_but_not_cancellation() -> None:
    with TemporaryDirectory() as root:
        _, sessions, automations = _stores(root)
        session = sessions.create_session({"workspacePath": "/w", "taskGoal": "g", "participants": ["human"]})
        for status in ("completed", "failed", "cancelled"):
            sessions.append_event(session["id"], relay_event("agent.completed", session["id"], {
                "runId": f"run_{status}", "agent": "codex", "status": status, "exitCode": 0}))
        rows = automations.claim_outbox(10, NOW)
        assert [row["event_type"] for row in rows] == ["run.completed", "run.failed"]


def test_claims_are_exclusive_until_stale() -> None:
    with TemporaryDirectory() as root:
        tasks, _, automations = _stores(root)
        tasks.create_task({"title": "Import"})
        assert len(automations.claim_outbox(10, NOW)) == 1
        assert automations.claim_outbox(10, NOW + timedelta(minutes=1)) == []
        reclaimed = automations.claim_outbox(10, NOW + timedelta(minutes=6))
        assert len(reclaimed) == 1
        automations.delete_outbox([reclaimed[0]["id"]])
        assert automations.claim_outbox(10, NOW + timedelta(hours=1)) == []


def test_webhook_secret_is_hashed_and_rotates() -> None:
    with TemporaryDirectory() as root:
        _, _, automations = _stores(root)
        first = automations.set_webhook_secret("R-1")
        assert automations.verify_webhook_secret("R-1", first)
        second = automations.set_webhook_secret("R-1")
        assert not automations.verify_webhook_secret("R-1", first)
        assert automations.verify_webhook_secret("R-1", second)
        assert not automations.verify_webhook_secret("R-2", second)
        automations.delete_webhook_secret("R-1")
        assert not automations.has_webhook_secret("R-1")


def test_state_round_trips_and_lists_pending() -> None:
    with TemporaryDirectory() as root:
        _, _, automations = _stores(root)
        assert automations.get_state("R-1")["pending"] is False
        automations.save_state("R-1", {**automations.get_state("R-1"), "pending": True,
                                       "pending_events": [{"eventType": "webhook"}], "pending_since": NOW})
        [state] = automations.list_pending_states()
        assert state["routine_id"] == "R-1"
        automations.clear_state("R-1")
        assert automations.list_pending_states() == []
```

(If a setup call errors because the store wants a different payload key, fix the setup, not the assertion.)

- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError`).

- [ ] **Step 3: Implement** `backend/relay/persistence/automation_store.py`:

```python
"""Durable plumbing for automations: the outbox, per-automation firing state,
and webhook secrets.

Outbox rows are written inside the task or session store's own transaction
(``store_transaction`` joins it), so an event and the automation's record of
it commit together or not at all. Only the database stores write them; the
file stores are test fixtures and run no automations. Routine ids are plain
text, not foreign keys: a row must outlive the routine it names.
"""

from __future__ import annotations

import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlalchemy import Boolean, Column, DateTime, Index, Integer, Table, Text, delete, insert, or_, select, update

from .store_common import (
    create_all_tables, database_id_column, json_type, new_database_id, shared_engine, store_transaction,
)
from .store_common import metadata as shared_metadata

STALE_CLAIM = timedelta(minutes=5)
SUBJECT_KEYS = ("id", "title", "status", "priority", "projectId", "assignedAgentId", "assignedTeamId")

automation_outbox = Table(
    "automation_outbox", shared_metadata,
    database_id_column(),
    Column("kind", Text, nullable=False),
    Column("event_type", Text, nullable=False),
    Column("source_type", Text, nullable=True),
    Column("source_id", Text, nullable=True),
    Column("target_routine_id", Text, nullable=True),
    Column("payload", json_type(), nullable=False),
    Column("origin_automation_id", Text, nullable=True),
    Column("depth", Integer, nullable=False, default=0),
    Column("created_at", DateTime(timezone=True), nullable=False),
    Column("claimed_at", DateTime(timezone=True), nullable=True),
    Index("ix_automation_outbox_claim", "claimed_at", "created_at"),
)

automation_state = Table(
    "automation_state", shared_metadata,
    Column("routine_id", Text, primary_key=True),
    Column("pending", Boolean, nullable=False, default=False),
    Column("pending_events", json_type(), nullable=False),
    Column("pending_dropped", Integer, nullable=False, default=0),
    Column("pending_since", DateTime(timezone=True), nullable=True),
    Column("fired_window_start", DateTime(timezone=True), nullable=True),
    Column("fired_count", Integer, nullable=False, default=0),
    Index("ix_automation_state_pending", "pending"),
)

automation_webhook_secrets = Table(
    "automation_webhook_secrets", shared_metadata,
    Column("routine_id", Text, primary_key=True),
    Column("secret_hash", Text, nullable=False),
    Column("created_at", DateTime(timezone=True), nullable=False),
)


def subject_of(task: dict[str, Any]) -> dict[str, Any]:
    return {key: task[key] for key in SUBJECT_KEYS if task.get(key) is not None}


def _row(kind: str, event_type: str, **fields: Any) -> dict[str, Any]:
    return {"kind": kind, "event_type": event_type, "payload": {}, "depth": 0, **fields}


def task_outbox_rows(before: dict[str, Any] | None, after: dict[str, Any]) -> list[dict[str, Any]]:
    """Rows a task write produces. Routine definitions never fire triggers;
    occurrences fire only status changes, stamped with where they came from."""
    if after.get("isRoutine") or after.get("deletedAt"):
        return []
    origin = after.get("sourceRoutineId")
    provenance = {
        "source_type": "task", "source_id": after["id"], "origin_automation_id": origin,
        "depth": int(after.get("routineTriggerDepth") or 0) + 1 if origin else 0,
    }
    if before is None:
        if origin:
            return []
        return [_row("task_event", "task.created", payload={"subject": subject_of(after)}, **provenance)]
    if before.get("status") == after.get("status"):
        return []
    payload = {"subject": subject_of(after), "from": before.get("status"), "to": after.get("status")}
    return [_row("task_event", "task.status_changed", payload=payload, **provenance)]


def session_outbox_rows(session_id: str, event: dict[str, Any]) -> list[dict[str, Any]]:
    if event.get("type") != "agent.completed" or event.get("status") not in ("completed", "failed"):
        return []
    payload = {"sessionId": session_id, "runId": event.get("runId"), "agent": event.get("agent")}
    if event["status"] == "failed" and event.get("error"):
        payload["error"] = str(event["error"])[:500]
    return [_row("run_event", f"run.{event['status']}", source_type="session", source_id=session_id, payload=payload)]


def insert_outbox_rows(conn: Any, rows: list[dict[str, Any]]) -> None:
    now = datetime.now(timezone.utc)
    for row in rows:
        conn.execute(insert(automation_outbox).values(id=new_database_id(), created_at=now, claimed_at=None, **row))


def _empty_state(routine_id: str) -> dict[str, Any]:
    return {"routine_id": routine_id, "pending": False, "pending_events": [], "pending_dropped": 0,
            "pending_since": None, "fired_window_start": None, "fired_count": 0}


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class DatabaseAutomationStore:
    def __init__(self, database_url: str, *, create_schema: bool = False) -> None:
        self.engine = shared_engine(database_url)
        if create_schema:
            create_all_tables(self.engine)

    def enqueue_webhook(self, routine_id: str, payload: Any) -> None:
        row = _row("webhook", "webhook", target_routine_id=routine_id, payload={"body": payload})
        with store_transaction(self.engine) as conn:
            insert_outbox_rows(conn, [row])

    def claim_outbox(self, limit: int, now: datetime) -> list[dict[str, Any]]:
        claimable = or_(automation_outbox.c.claimed_at.is_(None), automation_outbox.c.claimed_at < now - STALE_CLAIM)
        claimed: list[dict[str, Any]] = []
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(automation_outbox).where(claimable).order_by(automation_outbox.c.created_at).limit(limit)
            ).mappings().all()
            for row in rows:
                won = conn.execute(
                    update(automation_outbox).where(automation_outbox.c.id == row["id"], claimable).values(claimed_at=now)
                ).rowcount == 1
                if won:
                    claimed.append({key: row[key] for key in row.keys() if key != "claimed_at"})
        return claimed

    def delete_outbox(self, ids: list[str]) -> None:
        if ids:
            with store_transaction(self.engine) as conn:
                conn.execute(delete(automation_outbox).where(automation_outbox.c.id.in_(ids)))

    def prune_outbox(self, before: datetime) -> int:
        with store_transaction(self.engine) as conn:
            return conn.execute(delete(automation_outbox).where(automation_outbox.c.created_at < before)).rowcount

    def get_state(self, routine_id: str) -> dict[str, Any]:
        with store_transaction(self.engine) as conn:
            row = conn.execute(
                select(automation_state).where(automation_state.c.routine_id == routine_id)
            ).mappings().first()
        return dict(row) if row else _empty_state(routine_id)

    def save_state(self, routine_id: str, state: dict[str, Any]) -> None:
        values = {key: value for key, value in state.items() if key != "routine_id"}
        with store_transaction(self.engine) as conn:
            updated = conn.execute(
                update(automation_state).where(automation_state.c.routine_id == routine_id).values(**values)
            )
            if updated.rowcount == 0:
                conn.execute(insert(automation_state).values(routine_id=routine_id, **values))

    def clear_state(self, routine_id: str) -> None:
        """Forget pending events but keep the rate window: a fired automation
        still counts toward its hourly cap."""
        current = self.get_state(routine_id)
        self.save_state(routine_id, {**_empty_state(routine_id),
                                     "fired_window_start": current["fired_window_start"],
                                     "fired_count": current["fired_count"]})

    def list_pending_states(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(select(automation_state).where(automation_state.c.pending.is_(True))).mappings().all()
        return [dict(row) for row in rows]

    def set_webhook_secret(self, routine_id: str) -> str:
        token = secrets.token_urlsafe(32)
        with store_transaction(self.engine) as conn:
            conn.execute(delete(automation_webhook_secrets).where(automation_webhook_secrets.c.routine_id == routine_id))
            conn.execute(insert(automation_webhook_secrets).values(
                routine_id=routine_id, secret_hash=_hash(token), created_at=datetime.now(timezone.utc)))
        return token

    def verify_webhook_secret(self, routine_id: str, token: str) -> bool:
        with store_transaction(self.engine) as conn:
            stored = conn.scalar(select(automation_webhook_secrets.c.secret_hash)
                                 .where(automation_webhook_secrets.c.routine_id == routine_id))
        return bool(stored) and hmac.compare_digest(stored, _hash(token))

    def has_webhook_secret(self, routine_id: str) -> bool:
        with store_transaction(self.engine) as conn:
            found = conn.scalar(select(automation_webhook_secrets.c.routine_id)
                                .where(automation_webhook_secrets.c.routine_id == routine_id))
        return found is not None

    def delete_webhook_secret(self, routine_id: str) -> None:
        with store_transaction(self.engine) as conn:
            conn.execute(delete(automation_webhook_secrets).where(automation_webhook_secrets.c.routine_id == routine_id))
```

SQLite returns naive datetimes; when comparing `pending_since`/`fired_window_start` in Task 8, normalize with `value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value`.

- [ ] **Step 4: Hook the stores.** In `schema.py`: `from . import automation_store as _automation_store  # noqa: F401`. In `DatabaseTaskStore.create_task`, inside the transaction after the events loop: `insert_outbox_rows(conn, task_outbox_rows(None, task))`. In `_append_events_once`, after the events loop, still inside the `with`: `insert_outbox_rows(conn, task_outbox_rows(current, task))`. In `DatabaseSessionStore._append_event_once`, after the `update(self.sessions)` call: `insert_outbox_rows(conn, session_outbox_rows(session_id, event))`. Import inside the functions if a module-level import creates a cycle.

- [ ] **Step 5: Migration** `20261002_0082_automation_outbox.py` (`revision = "20261002_0082"`, `down_revision = "20261002_0081"`): `op.create_table` for the three tables with exactly the columns above (json columns as `sa.JSON().with_variant(postgresql.JSONB(), "postgresql")`; `automation_outbox.id` with the type `database_id_column()` produces — read it in `store_common.py`), the two indexes, and `op.drop_table` in reverse order in `downgrade`.

- [ ] **Step 6: Run, expect PASS.** Then `pytest tests/unit/test_task_store.py tests/unit/test_session_store.py -q` → PASS.
- [ ] **Step 7: Commit.** `git add -A backend && git commit -m "feat(backend): add transactional automation outbox"`

### Task 7: Triggered occurrences and the automation listing

**Files:**
- Modify: `backend/relay/persistence/task_store.py` (`routine_occurrence_events`, both stores: `create_triggered_occurrence`, `list_trigger_automations`)
- Modify: `backend/relay/persistence/protocols.py` (`TaskStore` protocol, next to `create_routine_occurrence` at ~L166)
- Test: `backend/tests/unit/test_triggered_occurrence.py`

**Interfaces:**
- Consumes: `trigger_kind` (Task 4); `routine_trigger_kind` column (Task 5).
- Produces:
  - `routine_occurrence_events(routine, agent, *, scheduled_for=None, trigger: dict | None = None)` — `trigger = {"kind": str, "depth": int, "context": str}`; appends `context` to the description and stamps `routineTriggerKind` / `routineTriggerDepth`.
  - `create_triggered_occurrence(self, routine_id: str, *, run_date: str, trigger_kind: str, depth: int, context: str) -> dict | None` — always creates (no per-date dedupe); returns `None` if the routine is missing, deleted, disabled, or has no agent/team/project. Appends `task.occurrence_created` (`{"occurrenceId", "scheduledFor", "triggerKind"}`) and a `task.activity` "Automation fired by <kind>: <occurrenceId>." to the routine; does **not** touch `routineNextRunDate`.
  - `list_trigger_automations(self) -> list[dict]` — enabled, non-deleted routines whose trigger kind is `task_event`, `run_event`, or `webhook`.

- [ ] **Step 1: Write failing tests** `backend/tests/unit/test_triggered_occurrence.py`:

```python
from __future__ import annotations

from tempfile import TemporaryDirectory

import pytest
from relay.persistence.task_store import DatabaseTaskStore, LocalTaskStore

ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


@pytest.fixture(params=["database", "local"])
def store(request):
    with TemporaryDirectory() as root:
        yield (DatabaseTaskStore(f"sqlite:///{root}/relay.db", create_schema=True)
               if request.param == "database" else LocalTaskStore(root))


def _automation(store, **extra):
    return store.create_task({
        "title": "Triage", "description": "Look into it.", "isRoutine": True, "routineEnabled": True,
        "assignedAgent": "codex", "assignedAgentId": "agent_1", "routineTrigger": ON_BLOCKED, **extra,
    })


def test_triggered_occurrences_are_never_deduped_by_date(store) -> None:
    routine = _automation(store)
    first = store.create_triggered_occurrence(routine["id"], run_date="2026-10-02", trigger_kind="task_event",
                                              depth=1, context="---\nTrigger context\nFired by: Task created")
    second = store.create_triggered_occurrence(routine["id"], run_date="2026-10-02", trigger_kind="task_event",
                                               depth=1, context="ctx")
    assert first["id"] != second["id"]
    assert first["description"] == "Look into it.\n\n---\nTrigger context\nFired by: Task created"
    assert first["routineTriggerKind"] == "task_event"
    assert first["routineTriggerDepth"] == 1
    assert first["sourceRoutineId"] == routine["id"]
    assert first["status"] == "assigned"
    updated = store.get_task(routine["id"])
    assert "routineNextRunDate" not in updated
    assert updated["occurrenceIds"][-2:] == [first["id"], second["id"]]


def test_disabled_or_unassigned_automation_creates_nothing(store) -> None:
    paused = _automation(store, routineEnabled=False)
    assert store.create_triggered_occurrence(paused["id"], run_date="2026-10-02", trigger_kind="task_event",
                                             depth=0, context="ctx") is None
    unassigned = store.create_task({"title": "x", "isRoutine": True, "routineEnabled": True,
                                    "routineTrigger": {"kind": "webhook"}})
    assert store.create_triggered_occurrence(unassigned["id"], run_date="2026-10-02", trigger_kind="webhook",
                                             depth=0, context="ctx") is None


def test_lists_only_enabled_event_and_webhook_automations(store) -> None:
    listening = _automation(store)
    webhook = _automation(store, routineTrigger={"kind": "webhook"})
    _automation(store, routineTrigger={"kind": "manual"})
    _automation(store, routineTrigger={"kind": "schedule"}, routineCadence="weekly", routineNextRunDate="2026-10-09")
    _automation(store, routineEnabled=False)
    assert {task["id"] for task in store.list_trigger_automations()} == {listening["id"], webhook["id"]}
```

(If the snapshot field for occurrence ids is not `occurrenceIds`, read `_apply_task_occurrence_created` in `store_common.py` and assert on the field it maintains.)

- [ ] **Step 2: Run, expect FAIL** (`AttributeError: create_triggered_occurrence`).

- [ ] **Step 3: Extend `routine_occurrence_events`** with keyword `trigger: dict[str, Any] | None = None`:

```python
    description = routine.get("description", "")
    if trigger:
        description = f"{description}\n\n{trigger['context']}" if description else trigger["context"]
```

Use `description` in the `task.created` payload, and add to it:

```python
                **(
                    {"routineTriggerKind": trigger["kind"], "routineTriggerDepth": trigger["depth"]}
                    if trigger
                    else {}
                ),
```

Add a shared helper:

```python
def triggered_occurrence_routine_events(
    routine_id: str, occurrence_id: str, scheduled_for: str, kind: str
) -> list[dict[str, Any]]:
    return [
        relay_task_event(
            "task.occurrence_created",
            routine_id,
            {"occurrenceId": occurrence_id, "scheduledFor": scheduled_for, "triggerKind": kind},
        ),
        relay_task_event(
            "task.activity",
            routine_id,
            {"activity": {"id": new_relay_id("act"), "createdAt": now_iso(),
                          "message": f"Automation fired by {kind}: {occurrence_id}."}},
        ),
    ]


def triggered_occurrence_allowed(routine: dict[str, Any]) -> bool:
    return bool(
        routine.get("isRoutine") and routine.get("routineEnabled") and not routine.get("deletedAt")
        and (routine.get("assignedAgent") or routine.get("assignedTeamId") or routine.get("projectId"))
    )
```

- [ ] **Step 4: `DatabaseTaskStore`.** Mirror `create_routine_occurrence` without the `existing` lookup:

```python
    def create_triggered_occurrence(
        self, routine_id: str, *, run_date: str, trigger_kind: str, depth: int, context: str
    ) -> dict[str, Any] | None:
        with store_transaction(self.engine) as conn:
            row = (
                conn.execute(
                    select(self.tasks.c.id, self.tasks.c.snapshot, self.tasks.c.version)
                    .where(self.tasks.c.id == routine_id)
                    .with_for_update()
                )
                .mappings()
                .first()
            )
            if not row:
                return None
            routine = self._current_snapshot(conn, row)
            if not triggered_occurrence_allowed(routine):
                return None
            occurrence_events = routine_occurrence_events(
                routine, routine.get("assignedAgent"), scheduled_for=run_date,
                trigger={"kind": trigger_kind, "depth": depth, "context": context},
            )
            occurrence = materialize_task_events(occurrence_events)
            occurrence_row = task_to_row(occurrence, version=len(occurrence_events))
            conn.execute(insert(self.tasks).values(**occurrence_row))
            for sequence, event in enumerate(occurrence_events):
                conn.execute(insert(self.events).values(**task_event_to_row(occurrence_row["id"], sequence, event)))
            routine_events = triggered_occurrence_routine_events(routine_id, occurrence["id"], run_date, trigger_kind)
            task_pk = row["id"]
            sequence = int(row["version"] or 0)
            for offset, event in enumerate(routine_events):
                conn.execute(insert(self.events).values(**task_event_to_row(task_pk, sequence + offset, event)))
            updated = apply_task_events(routine, routine_events, version=sequence)
            conn.execute(
                update(self.tasks)
                .where(self.tasks.c.id == task_pk)
                .values(**task_to_row(updated, version=sequence + len(routine_events), database_id=task_pk))
            )
        return occurrence

    def list_trigger_automations(self) -> list[dict[str, Any]]:
        with store_transaction(self.engine) as conn:
            rows = conn.execute(
                select(self.tasks.c.snapshot)
                .where(self.tasks.c.is_routine.is_(True))
                .where(self.tasks.c.routine_enabled.is_(True))
                .where(self.tasks.c.routine_trigger_kind.in_(TRIGGERED_KINDS))
                .order_by(self.tasks.c.created_at.asc())
            ).mappings().all()
        return [row["snapshot"] for row in rows if not row["snapshot"].get("deletedAt")]
```

with module constant `TRIGGERED_KINDS = ("task_event", "run_event", "webhook")`.

- [ ] **Step 5: `LocalTaskStore`.** Same contract with the file store's pattern (see its `create_routine_occurrence`): under `self._lock`, `get_task`, check `triggered_occurrence_allowed`, write the occurrence events file + snapshot, `_append_jsonl` the routine events, rewrite the routine snapshot with `materialize_task_events([*routine.get("events", []), *routine_events])`. `list_trigger_automations` filters `self.list_tasks()` with `task.get("isRoutine") and task.get("routineEnabled") and not task.get("deletedAt") and trigger_kind(task) in TRIGGERED_KINDS`.

- [ ] **Step 6: Protocol.** Add both method signatures to `TaskStore` in `protocols.py`.
- [ ] **Step 7: Run, expect PASS**, plus `pytest tests/unit/test_task_store.py -q`.
- [ ] **Step 8: Commit.** `git add -A backend && git commit -m "feat(backend): create occurrences for fired automations"`

### Task 8: Matcher, coalescing, firing, scheduler wiring

**Files:**
- Create: `backend/relay/automations/matcher.py`
- Modify: `backend/relay/tasks/scheduler.py` (`SchedulerTickResult`, `TaskScheduler.__init__`, `_tick_sync`)
- Modify: `backend/relay/app.py` (build `DatabaseAutomationStore`, `app.state.automation_store`, pass matcher into `task_scheduler_from_env`)
- Test: `backend/tests/unit/test_automation_matcher.py`

**Interfaces:**
- Consumes: Task 4 (`event_matches`, `trigger_of`, `trigger_kind`, `trigger_context_block`), Task 6 (`DatabaseAutomationStore`, `subject_of`), Task 7 (`create_triggered_occurrence`, `list_trigger_automations`).
- Produces: `AutomationMatcher(*, task_store, session_store, automation_store, now: Callable[[], datetime] = utcnow, today: Callable[[], date] = date.today, max_depth: int = 3, max_runs_per_hour: int = 6, batch: int = 200)` with `run() -> int` (number fired). `TaskScheduler(..., automation_matcher: AutomationMatcher | None = None)`; `SchedulerTickResult.fired: int = 0`. App state `automation_store`.

- [ ] **Step 1: Write failing tests** `backend/tests/unit/test_automation_matcher.py`:

```python
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from tempfile import TemporaryDirectory

import pytest
from relay.automations.matcher import AutomationMatcher
from relay.persistence.automation_store import DatabaseAutomationStore
from relay.persistence.session_store import DatabaseSessionStore
from relay.persistence.task_store import DatabaseTaskStore

ON_BLOCKED = {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "blocked"}}


class Clock:
    def __init__(self) -> None:
        self.value = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)

    def __call__(self) -> datetime:
        return self.value


@pytest.fixture
def world():
    with TemporaryDirectory() as root:
        url = f"sqlite:///{root}/relay.db"
        tasks = DatabaseTaskStore(url, create_schema=True)
        sessions = DatabaseSessionStore(url, create_schema=True)
        automations = DatabaseAutomationStore(url, create_schema=True)
        clock = Clock()
        matcher = AutomationMatcher(task_store=tasks, session_store=sessions, automation_store=automations,
                                    now=clock, today=lambda: date(2026, 10, 2))
        yield tasks, automations, matcher, clock


def _automation(tasks, trigger=ON_BLOCKED, **extra):
    return tasks.create_task({"title": "Triage", "description": "Fix it.", "isRoutine": True,
                              "routineEnabled": True, "assignedAgent": "codex", "assignedAgentId": "agent_1",
                              "routineTrigger": trigger, **extra})


def _block(tasks, title="Nightly import"):
    task = tasks.create_task({"title": title})
    return tasks.update_task(task["id"], {"status": "blocked", "blockerReason": "stuck"})


def _occurrences(tasks, routine_id):
    return [task for task in tasks.list_tasks() if task.get("sourceRoutineId") == routine_id]


def test_matching_event_fires_one_occurrence_with_context(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks)
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, routine["id"])
    assert "Trigger context" in occurrence["description"]
    assert '"Nightly import" — backlog → blocked' in occurrence["description"]


def test_non_matching_event_does_nothing(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks, {"kind": "task_event", "on": "status_changed", "filters": {"toStatus": "done"}})
    _block(tasks)
    assert matcher.run() == 0
    assert _occurrences(tasks, routine["id"]) == []


def test_burst_while_running_coalesces_into_one_next_run(world) -> None:
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    matcher.run()
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "running"})
    for index in range(3):
        _block(tasks, f"burst {index}")
    assert matcher.run() == 0
    assert automations.get_state(routine["id"])["pending"] is True
    tasks.update_task(first["id"], {"status": "done"})
    assert matcher.run() == 1
    second = [task for task in _occurrences(tasks, routine["id"]) if task["id"] != first["id"]][0]
    assert "(3 events" in second["description"]


def test_parked_occurrence_does_not_hold_events(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks, "first")
    matcher.run()
    [first] = _occurrences(tasks, routine["id"])
    tasks.update_task(first["id"], {"status": "review"})
    _block(tasks, "second")
    assert matcher.run() == 1


def test_own_occurrence_never_refires(world) -> None:
    tasks, _, matcher, _ = world
    routine = _automation(tasks)
    _block(tasks)
    matcher.run()
    [occurrence] = _occurrences(tasks, routine["id"])
    tasks.update_task(occurrence["id"], {"status": "blocked", "blockerReason": "loop?"})
    assert matcher.run() == 0
    assert len(_occurrences(tasks, routine["id"])) == 1


def test_chains_stop_past_max_depth(world) -> None:
    tasks, _, matcher, _ = world
    _automation(tasks)
    deep = tasks.create_task({"title": "deep", "sourceRoutineId": "other", "routineTriggerDepth": 3})
    tasks.update_task(deep["id"], {"status": "blocked", "blockerReason": "x"})
    assert matcher.run() == 0


def test_rate_cap_pauses_the_automation(world) -> None:
    tasks, _, matcher, clock = world
    routine = _automation(tasks)
    for index in range(7):
        _block(tasks, f"t{index}")
        matcher.run()
        for occurrence in _occurrences(tasks, routine["id"]):
            if occurrence["status"] != "done":
                tasks.update_task(occurrence["id"], {"status": "done"})
        clock.value += timedelta(minutes=1)
    paused = tasks.get_task(routine["id"])
    assert len(_occurrences(tasks, routine["id"])) == 6
    assert paused["routineEnabled"] is False
    assert paused["routineDisabledReason"] == "rate_limited"


def test_webhook_rows_reach_only_their_automation(world) -> None:
    tasks, automations, matcher, _ = world
    hooked = _automation(tasks, {"kind": "webhook"})
    other = _automation(tasks, {"kind": "webhook"})
    automations.enqueue_webhook(hooked["id"], {"ref": "main"})
    assert matcher.run() == 1
    [occurrence] = _occurrences(tasks, hooked["id"])
    assert '"ref": "main"' in occurrence["description"]
    assert _occurrences(tasks, other["id"]) == []


def test_deleted_automation_clears_pending_state(world) -> None:
    tasks, automations, matcher, _ = world
    routine = _automation(tasks)
    automations.save_state(routine["id"], {**automations.get_state(routine["id"]), "pending": True,
                                           "pending_events": [{"eventType": "webhook", "payload": {}, "depth": 0}],
                                           "pending_since": datetime(2026, 10, 2, tzinfo=timezone.utc)})
    tasks.delete_task(routine["id"])
    assert matcher.run() == 0
    assert automations.list_pending_states() == []


def test_pending_events_expire_after_a_day(world) -> None:
    tasks, automations, matcher, clock = world
    routine = tasks.create_task({"title": "No target", "isRoutine": True, "routineEnabled": True,
                                 "routineTrigger": ON_BLOCKED})
    _block(tasks)
    matcher.run()
    assert automations.get_state(routine["id"])["pending"] is True
    clock.value += timedelta(hours=25)
    matcher.run()
    assert automations.list_pending_states() == []
```

(`tasks.delete_task` may take extra arguments; match its signature. The "No target" routine may be refused at creation because enabled routines need a target — if so, create it with a target, then clear the assignment through `update_task(..., {"assignedAgentId": None})`; the assertion is what matters.)

- [ ] **Step 2: Run, expect FAIL** (`ModuleNotFoundError: relay.automations.matcher`).

- [ ] **Step 3: Implement** `backend/relay/automations/matcher.py`:

```python
"""Turn outbox rows into automation runs.

Each scheduler tick drains the outbox, matches every row against the
enabled event and webhook automations, and parks matches as pending state
per automation. It then fires at most one occurrence per pending automation:
events that arrive while a run is in flight collapse into the next run's
Trigger context instead of each starting their own.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from typing import Any

from loguru import logger

from ..persistence.automation_store import subject_of
from .trigger import event_matches, trigger_context_block, trigger_kind, trigger_of

MAX_AUTOMATION_DEPTH = 3
MAX_PENDING_EVENTS = 20
PENDING_TTL = timedelta(hours=24)
OUTBOX_RETENTION = timedelta(days=7)
RATE_WINDOW = timedelta(hours=1)
IN_FLIGHT_STATUSES = frozenset({"backlog", "assigned", "running"})
RATE_LIMITED = "rate_limited"


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _aware(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value


class AutomationMatcher:
    def __init__(
        self,
        *,
        task_store: Any,
        session_store: Any,
        automation_store: Any,
        now: Callable[[], datetime] = _utcnow,
        today: Callable[[], date] = date.today,
        max_depth: int = MAX_AUTOMATION_DEPTH,
        max_runs_per_hour: int = 6,
        batch: int = 200,
    ) -> None:
        self.task_store = task_store
        self.session_store = session_store
        self.automation_store = automation_store
        self._now = now
        self._today = today
        self.max_depth = max_depth
        self.max_runs_per_hour = max_runs_per_hour
        self.batch = batch

    def run(self) -> int:
        now = self._now()
        self._drain(now)
        return self._fire(now)

    # -- draining ---------------------------------------------------------

    def _drain(self, now: datetime) -> None:
        rows = self.automation_store.claim_outbox(self.batch, now)
        if rows:
            automations = {task["id"]: task for task in self.task_store.list_trigger_automations()}
            for row in rows:
                event = self._enrich(row)
                if event is None:
                    continue
                for automation in self._targets(row, event, automations):
                    if self._is_loop(automation, event):
                        logger.info("Automation event dropped as a loop", routine_id=automation["id"],
                                    event_type=event["eventType"], depth=event["depth"])
                        continue
                    self._mark_pending(automation["id"], event, now)
            self.automation_store.delete_outbox([row["id"] for row in rows])
        self.automation_store.prune_outbox(now - OUTBOX_RETENTION)

    def _targets(self, row: dict[str, Any], event: dict[str, Any],
                 automations: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
        target_id = row.get("target_routine_id")
        if target_id:
            target = automations.get(target_id)
            return [target] if target and trigger_kind(target) == "webhook" else []
        return [task for task in automations.values() if event_matches(trigger_of(task), event)]

    def _is_loop(self, automation: dict[str, Any], event: dict[str, Any]) -> bool:
        return event.get("originAutomationId") == automation["id"] or event["depth"] > self.max_depth

    def _enrich(self, row: dict[str, Any]) -> dict[str, Any] | None:
        payload = row.get("payload") or {}
        if row["kind"] == "webhook":
            return {"eventType": "webhook", "payload": payload.get("body"), "depth": 0}
        if row["kind"] == "task_event":
            return {"eventType": row["event_type"], "subject": payload.get("subject") or {},
                    "fromStatus": payload.get("from"), "toStatus": payload.get("to"),
                    "originAutomationId": row.get("origin_automation_id"), "depth": int(row.get("depth") or 0)}
        return self._enrich_run(row, payload)

    def _enrich_run(self, row: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any] | None:
        session_id = row.get("source_id") or payload.get("sessionId")
        try:
            session = self.session_store.get_session(session_id)
        except (KeyError, FileNotFoundError):
            return None
        run = next((item for item in session.get("agentRuns", []) if item.get("id") == payload.get("runId")), {})
        linked = [task for task in self.task_store.list_tasks_for_session(session_id) if not task.get("isRoutine")]
        task = linked[0] if linked else None
        subject = subject_of(task) if task else {"projectId": session.get("projectId")}
        if not subject.get("assignedAgentId") and run.get("logicalAgentId"):
            subject = {**subject, "assignedAgentId": run["logicalAgentId"]}
        origin = task.get("sourceRoutineId") if task else None
        depth = int(task.get("routineTriggerDepth") or 0) + 1 if origin else 0
        return {"eventType": row["event_type"], "subject": subject, "sessionId": session_id,
                "error": payload.get("error"), "originAutomationId": origin, "depth": depth}

    def _mark_pending(self, routine_id: str, event: dict[str, Any], now: datetime) -> None:
        state = self.automation_store.get_state(routine_id)
        events = list(state["pending_events"])
        dropped = int(state["pending_dropped"])
        if len(events) < MAX_PENDING_EVENTS:
            events = [*events, event]
        else:
            dropped += 1
        self.automation_store.save_state(routine_id, {
            **state, "pending": True, "pending_events": events, "pending_dropped": dropped,
            "pending_since": state["pending_since"] or now,
        })

    # -- firing -----------------------------------------------------------

    def _fire(self, now: datetime) -> int:
        fired = 0
        for state in self.automation_store.list_pending_states():
            if self._fire_one(state, now):
                fired += 1
        return fired

    def _fire_one(self, state: dict[str, Any], now: datetime) -> bool:
        routine_id = state["routine_id"]
        routine = self._load(routine_id)
        if not routine or not routine.get("routineEnabled") or trigger_kind(routine) == "schedule":
            self.automation_store.clear_state(routine_id)
            return False
        if now - _aware(state["pending_since"]) > PENDING_TTL:
            count = len(state["pending_events"]) + int(state["pending_dropped"])
            self.task_store.record_activity(routine_id, f"Automation dropped {count} pending events after 24 hours without a run.")
            logger.warning("Automation pending events expired", routine_id=routine_id, count=count)
            self.automation_store.clear_state(routine_id)
            return False
        if self._in_flight(routine):
            return False
        window_start = _aware(state["fired_window_start"])
        count = int(state["fired_count"])
        if window_start is None or now - window_start >= RATE_WINDOW:
            window_start, count = now, 0
        if count >= self.max_runs_per_hour:
            self.task_store.update_task(routine_id, {"routineEnabled": False, "routineDisabledReason": RATE_LIMITED})
            self.task_store.record_activity(routine_id, f"Automation paused: more than {self.max_runs_per_hour} runs in an hour.")
            logger.warning("Automation paused by rate cap", routine_id=routine_id)
            self.automation_store.clear_state(routine_id)
            return False
        events = state["pending_events"]
        occurrence = self.task_store.create_triggered_occurrence(
            routine_id,
            run_date=self._today().isoformat(),
            trigger_kind=trigger_kind(routine),
            depth=max(int(event.get("depth") or 0) for event in events),
            context=trigger_context_block(events, int(state["pending_dropped"])),
        )
        if not occurrence:
            # No agent, team, or project yet: keep the events until one is
            # assigned or they expire, and say so once.
            logger.info("Automation could not start", routine_id=routine_id)
            return False
        self.automation_store.save_state(routine_id, {
            "routine_id": routine_id, "pending": False, "pending_events": [], "pending_dropped": 0,
            "pending_since": None, "fired_window_start": window_start, "fired_count": count + 1,
        })
        logger.info("Automation fired", routine_id=routine_id, occurrence_id=occurrence["id"], events=len(events))
        return True

    def _load(self, task_id: str) -> dict[str, Any] | None:
        try:
            task = self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
        return None if task.get("deletedAt") or not task.get("isRoutine") else task

    def _in_flight(self, routine: dict[str, Any]) -> bool:
        for occurrence_id in reversed((routine.get("occurrenceIds") or [])[-5:]):
            occurrence = self._load_any(occurrence_id)
            if occurrence and not occurrence.get("deletedAt") and occurrence.get("status") in IN_FLIGHT_STATUSES:
                return True
        return False

    def _load_any(self, task_id: str) -> dict[str, Any] | None:
        try:
            return self.task_store.get_task(task_id)
        except (KeyError, FileNotFoundError):
            return None
```

The no-target case logs at most once per tick; to keep the routine's activity from filling up, do not call `record_activity` there.

- [ ] **Step 4: Scheduler wiring.** In `scheduler.py`: add `fired: int = 0` to `SchedulerTickResult`; add `automation_matcher: Any | None = None` to `TaskScheduler.__init__` (store as `self.automation_matcher`); in `_tick_sync`, first line inside `with compact_task_writes():`

```python
            fired = self._fire_automations()
```

pass `fired=fired` into the result, and add:

```python
    def _fire_automations(self) -> int:
        # A broken automation must not stop scheduled routines or dispatch.
        if not self.automation_matcher:
            return 0
        try:
            return self.automation_matcher.run()
        except Exception:
            logger.exception("Automation matching failed")
            return 0
```

The occurrences it creates are `assigned`, so `_dispatch_assigned_tasks` in the same tick dispatches them.

- [ ] **Step 5: App wiring.** In `app.py`, add `automation_store_from_env()` beside `task_store_from_env`:

```python
def automation_store_from_env() -> DatabaseAutomationStore:
    database_url = database_url_from_env(setting="database-only automation storage")
    return DatabaseAutomationStore(database_url, create_schema=database_url.startswith("sqlite"))
```

In `create_app` build `automation_store = automation_store_from_env()` after the task store; set `app.state.automation_store = automation_store`; give `task_scheduler_from_env` keyword params `session_store` and `automation_store` and construct:

```python
        automation_matcher=AutomationMatcher(
            task_store=task_store,
            session_store=session_store,
            automation_store=automation_store,
            max_runs_per_hour=max(1, int(os.environ.get("RELAY_AUTOMATION_MAX_RUNS_PER_HOUR", "6"))),
            batch=max(1, int(os.environ.get("RELAY_AUTOMATION_OUTBOX_BATCH", "200"))),
        ),
```

Pass `session_store=session_store, automation_store=automation_store` from the `create_app` call site.

- [ ] **Step 6: Integration test** — append to `test_automation_matcher.py` a test that builds `create_app(root)` (scheduler enabled, `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS=3600`), creates an agent and an event automation through the API (helpers from `tests/api/test_tasks.py`), blocks a task through `PATCH /api/v1/tasks/{id}`, runs `asyncio.run(app.state.task_scheduler.tick())`, and asserts `result.fired == 1` plus one occurrence with `sourceRoutineId` equal to the automation. Dispatch may queue (no ready node); assert only on the occurrence.

- [ ] **Step 7: Run, expect PASS**, plus `pytest tests/unit/test_task_scheduler.py tests/api/test_tasks.py -q`.
- [ ] **Step 8: Commit.** `git add -A backend && git commit -m "feat(backend): match and fire event automations each tick"`

### Task 9: Webhook endpoint, secret management, run ledger fields

**Files:**
- Create: `backend/relay/api/automation_routes.py`
- Modify: `backend/relay/app.py` (`api_routers` tuple; `app.state.automation_webhook_limiter`)
- Modify: `backend/relay/api/task_routes.py` (`run_row`; `update_task` deletes the secret when the kind leaves `webhook`)
- Test: `backend/tests/api/test_automation_webhook.py`

**Interfaces:**
- Consumes: `app.state.automation_store` (Task 8), `trigger_kind` (Task 4).
- Produces:
  - `POST /api/v1/automations/{routine_id}/webhook` → `202 {"accepted": true}`; 401 bad/missing token or unknown routine; 409 disabled/deleted/not a webhook automation; 413 > 64 KB; 415 non-JSON content type; 400 malformed JSON; 429 over rate.
  - `GET /api/v1/tasks/{task_id}/automation/webhook-secret` → `{"configured": bool, "path": str, "header": "X-Relay-Automation-Token"}`.
  - `POST /api/v1/tasks/{task_id}/automation/webhook-secret` → `201 {"secret": str, "path": str, "header": str}`. Owner, assignee, or admin; 409 when the task is not a webhook automation.
  - Run ledger rows (`GET /tasks/{id}/runs`) gain `triggerKind: str | null`.

- [ ] **Step 1: Write failing tests** `backend/tests/api/test_automation_webhook.py`:

```python
from __future__ import annotations

from tempfile import TemporaryDirectory

from test_automation_triggers_api import _client, _routine

HEADER = "X-Relay-Automation-Token"


def _webhook_automation(client, agent) -> tuple[dict, str]:
    routine = _routine(client, agent, routineTrigger={"kind": "webhook"})
    response = client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret")
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["path"] == f"/api/v1/automations/{routine['id']}/webhook"
    return routine, body["secret"]


def test_webhook_accepts_json_with_the_secret(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        response = client.post(f"/api/v1/automations/{routine['id']}/webhook",
                               json={"ref": "main"}, headers={HEADER: secret})
        assert response.status_code == 202
        assert response.json() == {"accepted": True}
        [row] = client.app.state.automation_store.claim_outbox(10, __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc))
        assert row["payload"] == {"body": {"ref": "main"}}


def test_webhook_refuses_bad_tokens_and_unknown_routines_alike(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, _ = _webhook_automation(client, agent)
        assert client.post(f"/api/v1/automations/{routine['id']}/webhook", json={}).status_code == 401
        assert client.post(f"/api/v1/automations/{routine['id']}/webhook", json={},
                           headers={HEADER: "wrong"}).status_code == 401
        assert client.post("/api/v1/automations/nope/webhook", json={},
                           headers={HEADER: "wrong"}).status_code == 401


def test_webhook_rejects_oversize_and_non_json(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, content=b"x", headers={HEADER: secret, "content-type": "text/plain"}).status_code == 415
        big = b'{"blob":"' + b"x" * (64 * 1024) + b'"}'
        assert client.post(url, content=big, headers={HEADER: secret, "content-type": "application/json"}).status_code == 413
        assert client.post(url, content=b"{nope", headers={HEADER: secret, "content-type": "application/json"}).status_code == 400


def test_webhook_to_paused_automation_is_refused(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineEnabled": False})
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, json={}, headers={HEADER: secret}).status_code == 409
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineEnabled": True})
        from datetime import datetime, timezone
        assert client.app.state.automation_store.claim_outbox(10, datetime.now(timezone.utc)) == []


def test_rotating_invalidates_the_old_secret_and_status_reports_it(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, first = _webhook_automation(client, agent)
        second = client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").json()["secret"]
        url = f"/api/v1/automations/{routine['id']}/webhook"
        assert client.post(url, json={}, headers={HEADER: first}).status_code == 401
        assert client.post(url, json={}, headers={HEADER: second}).status_code == 202
        status = client.get(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").json()
        assert status["configured"] is True
        assert "secret" not in status


def test_leaving_webhook_deletes_the_secret(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine, secret = _webhook_automation(client, agent)
        client.patch(f"/api/v1/tasks/{routine['id']}", json={"routineTrigger": {"kind": "manual"}})
        assert client.app.state.automation_store.has_webhook_secret(routine["id"]) is False


def test_secret_requires_a_webhook_automation(monkeypatch) -> None:
    with TemporaryDirectory() as root:
        client, agent = _client(monkeypatch, root)
        routine = _routine(client, agent)
        assert client.post(f"/api/v1/tasks/{routine['id']}/automation/webhook-secret").status_code == 409
```

(Clean up the `__import__` calls into normal `datetime` imports when writing the file.)

- [ ] **Step 2: Run, expect FAIL** (404s).

- [ ] **Step 3: Implement** `backend/relay/api/automation_routes.py`:

```python
"""Inbound webhooks for automations, and the secret that guards them.

The webhook only queues: it writes an outbox row and answers 202. The
scheduler's matcher turns the row into a run, the same as any other trigger.
"""

from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from ..automations.trigger import trigger_kind
from .contract import API_PREFIX
from .deps import AppContextDep
from .helpers import get_task_for_actor, request_actor

router = APIRouter()

WEBHOOK_TOKEN_HEADER = "X-Relay-Automation-Token"
WEBHOOK_BODY_LIMIT = 64 * 1024


def webhook_path(routine_id: str) -> str:
    return f"{API_PREFIX}/automations/{routine_id}/webhook"


async def _capped_body(request: Request) -> bytes:
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > WEBHOOK_BODY_LIMIT:
        raise HTTPException(413, "Webhook body exceeds 64 KB.")
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > WEBHOOK_BODY_LIMIT:
            raise HTTPException(413, "Webhook body exceeds 64 KB.")
    return bytes(body)


@router.post("/automations/{routine_id}/webhook", status_code=202)
async def receive_automation_webhook(routine_id: str, request: Request) -> dict[str, Any]:
    retry_after = request.app.state.automation_webhook_limiter.consume(routine_id)
    if retry_after:
        raise HTTPException(429, "Too many webhook calls.", headers={"Retry-After": str(retry_after)})
    store = request.app.state.automation_store
    token = request.headers.get(WEBHOOK_TOKEN_HEADER, "")
    if not token or not await run_in_threadpool(store.verify_webhook_secret, routine_id, token):
        raise HTTPException(401, "Invalid automation token.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Webhook body must be application/json.")
    body = await _capped_body(request)
    try:
        payload = json.loads(body or b"null")
    except ValueError as error:
        raise HTTPException(400, "Webhook body is not valid JSON.") from error
    try:
        routine = await run_in_threadpool(request.app.state.task_store.get_task, routine_id)
    except (KeyError, FileNotFoundError) as error:
        raise HTTPException(409, "automation_unavailable") from error
    if routine.get("deletedAt") or not routine.get("routineEnabled") or trigger_kind(routine) != "webhook":
        raise HTTPException(409, "automation_unavailable")
    await run_in_threadpool(store.enqueue_webhook, routine_id, payload)
    return {"accepted": True}


def _webhook_automation_for_actor(request: Request, ctx: AppContextDep, task_id: str) -> dict[str, Any]:
    actor = request_actor(request, ctx.auth_store)
    task = get_task_for_actor(ctx.task_store, task_id, actor)
    if not task.get("isRoutine") or trigger_kind(task) != "webhook":
        raise HTTPException(409, "automation_not_webhook")
    editors = {task.get("ownerEmployeeId"), task.get("assigneeEmployeeId")} - {None}
    if not actor["isAdmin"] and actor.get("employeeId") not in editors:
        raise HTTPException(403, "Only the automation's owner or an admin can manage its webhook.")
    return task


@router.get("/tasks/{task_id}/automation/webhook-secret")
def webhook_secret_status(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _webhook_automation_for_actor(request, ctx, task_id)
    configured = request.app.state.automation_store.has_webhook_secret(task_id)
    return {"configured": configured, "path": webhook_path(task_id), "header": WEBHOOK_TOKEN_HEADER}


@router.post("/tasks/{task_id}/automation/webhook-secret", status_code=201)
def rotate_webhook_secret(task_id: str, request: Request, ctx: AppContextDep) -> dict[str, Any]:
    _webhook_automation_for_actor(request, ctx, task_id)
    secret = request.app.state.automation_store.set_webhook_secret(task_id)
    return {"secret": secret, "path": webhook_path(task_id), "header": WEBHOOK_TOKEN_HEADER}
```

- [ ] **Step 4: Mount and limiter.** In `app.py` import `automation_routes`, add `automation_routes.router` to `api_routers`, and set `app.state.automation_webhook_limiter = AuthRateLimiter(attempts=int(os.environ.get("RELAY_AUTOMATION_WEBHOOK_RATE_LIMIT", "60")), window_seconds=60)`.

- [ ] **Step 5: Secret cleanup on kind change.** In `update_task` (task_routes), after the store write succeeds:

```python
    if trigger_kind(current) == "webhook" and trigger_kind(task) != "webhook":
        request.app.state.automation_store.delete_webhook_secret(task_id)
```

(`update_task` already has `request`; if not, add `request: Request` to its signature the way other routes do.)

- [ ] **Step 6: Ledger field.** In `run_row` add `"triggerKind": task.get("routineTriggerKind"),`.

- [ ] **Step 7: Run, expect PASS**, plus `pytest tests/api/test_url_contract.py tests/api/test_tasks.py -q` (the OpenAPI test asserts unique operation ids and tags; fix if it flags the new routes).
- [ ] **Step 8: Commit.** `git add -A backend && git commit -m "feat(backend): accept automation webhooks"`

---

# Phase 3 — Web trigger UI

### Task 10: Trigger model, form state, list state and filter

**Files:**
- Modify: `web/src/types.ts` (trigger types; `routineTrigger`/`routineDisabledReason` on the task list item, task, and `TaskMutationInput` interfaces next to `routineEnabled`; `triggerKind` on the task-run type)
- Create: `web/src/lib/automationTrigger.ts`
- Modify: `web/src/lib/taskBoardForm.ts`, `web/src/lib/routine.ts`, `web/src/lib/appRoute.ts` (`LIST_FILTER_PARAMS.routines`), `web/src/components/RoutineStateBadge.tsx`, `web/src/components/task-board/RoutineChrome.tsx`
- Test: `web/tests/automationTrigger.test.ts`; update `web/tests/taskBoardForm.test.ts`, `web/tests/appRoute.test.ts`

**Interfaces:**
- Consumes: the backend wire shape from Tasks 5 and 9.
- Produces:
  - types `RoutineTriggerKind`, `RoutineTriggerOn`, `RoutineTriggerFilters`, `RoutineTrigger`.
  - `automationTrigger.ts`: `TRIGGER_KINDS`, `TRIGGER_ON: Record<"task_event" | "run_event", readonly RoutineTriggerOn[]>`, `SCHEDULE_TRIGGER`, `TITLE_CONTAINS_MAX = 120`, `triggerOf(task) -> RoutineTrigger`, `isEventKind(kind)`, `triggerForKind(kind) -> RoutineTrigger`, `normalizeTriggerForSave(trigger) -> RoutineTrigger`, `triggersEqual(a, b) -> boolean`, `triggerError(trigger) -> string | null` (an i18n key).
  - `RoutineTaskFormState.routineTrigger: RoutineTrigger`; `RoutineState` gains `"listening"`; `RoutineFilters.trigger: "all" | RoutineTriggerKind`.

- [ ] **Step 1: Write failing tests** `web/tests/automationTrigger.test.ts`:

```ts
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeTriggerForSave, triggerError, triggerForKind, triggerOf, triggersEqual,
} from "../src/lib/automationTrigger.ts";
import { routineState } from "../src/lib/routine.ts";
import type { RelayTaskListItem } from "../src/types.ts";

describe("automation triggers", () => {
  it("reads a missing or unknown trigger as a schedule", () => {
    assert.deepEqual(triggerOf({}), { kind: "schedule" });
    assert.deepEqual(triggerOf({ routineTrigger: { kind: "bogus" as never } }), { kind: "schedule" });
  });

  it("gives event kinds a default `on` and others none", () => {
    assert.deepEqual(triggerForKind("task_event"), { kind: "task_event", on: "status_changed" });
    assert.deepEqual(triggerForKind("run_event"), { kind: "run_event", on: "failed" });
    assert.deepEqual(triggerForKind("webhook"), { kind: "webhook" });
  });

  it("drops empty filters and status filters that do not apply", () => {
    assert.deepEqual(normalizeTriggerForSave({
      kind: "task_event", on: "created",
      filters: { projectId: "", toStatus: "blocked", titleContains: "  nightly " },
    }), { kind: "task_event", on: "created", filters: { titleContains: "nightly" } });
    assert.deepEqual(normalizeTriggerForSave({ kind: "webhook", filters: { projectId: "p" } }), { kind: "webhook" });
  });

  it("compares triggers by their saved shape", () => {
    assert.ok(triggersEqual({ kind: "task_event", on: "created", filters: { projectId: "" } }, { kind: "task_event", on: "created" }));
    assert.ok(!triggersEqual({ kind: "webhook" }, { kind: "manual" }));
  });

  it("flags an over-long title filter", () => {
    assert.equal(triggerError({ kind: "task_event", on: "created", filters: { titleContains: "x".repeat(121) } }),
      "automation.errors.title_too_long");
    assert.equal(triggerError({ kind: "webhook" }), null);
  });

  it("shows enabled event automations as listening, not unscheduled", () => {
    const base = { id: "R-1", isRoutine: true, routineEnabled: true } as RelayTaskListItem;
    assert.equal(routineState({ ...base, routineTrigger: { kind: "webhook" } }, new Set()), "listening");
    assert.equal(routineState(base, new Set()), "unscheduled");
    assert.equal(routineState({ ...base, routineEnabled: false, routineTrigger: { kind: "webhook" } }, new Set()), "paused");
  });
});
```

In `web/tests/taskBoardForm.test.ts`, add: `emptyRoutineForm(user).routineTrigger` deep-equals `{ kind: "schedule" }`, and `taskBoardFormsEqual` returns `false` when only `routineTrigger` differs. In `web/tests/appRoute.test.ts` add `assert.equal(canonicalBrowserUrl("/automations", "?trigger=webhook"), "/automations?trigger=webhook")` and that `?trigger=bogus` is dropped.

- [ ] **Step 2: Run, expect FAIL.** `npx tsc -p packages/tsconfig.json` fails on the missing module.

- [ ] **Step 3: Types** in `web/src/types.ts` (near `TaskRoutineType`):

```ts
export type RoutineTriggerKind = "schedule" | "task_event" | "run_event" | "webhook" | "manual";
export type RoutineTriggerOn = "created" | "status_changed" | "completed" | "failed";
export interface RoutineTriggerFilters {
  projectId?: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
  fromStatus?: TaskStatus;
  toStatus?: TaskStatus;
  priority?: TaskPriority;
  titleContains?: string;
}
export interface RoutineTrigger {
  kind: RoutineTriggerKind;
  on?: RoutineTriggerOn;
  filters?: RoutineTriggerFilters;
}
```

Add `routineTrigger?: RoutineTrigger;` and `routineDisabledReason?: string;` beside every `routineEnabled` field (task, list item, brief, mutation input), and `triggerKind?: RoutineTriggerKind | null;` to the run-ledger row type used by `RecordRuns`.

- [ ] **Step 4: `web/src/lib/automationTrigger.ts`:**

```ts
import type { RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn } from "../types.js";

/* What starts an automation. Mirrors backend/relay/automations/trigger.py —
   keep the kinds, `on` values, and filter rules in step with it. */

export const TRIGGER_KINDS: readonly RoutineTriggerKind[] = ["schedule", "task_event", "run_event", "webhook", "manual"];
export const TRIGGER_ON: Readonly<Record<"task_event" | "run_event", readonly RoutineTriggerOn[]>> = {
  task_event: ["status_changed", "created"],
  run_event: ["failed", "completed"],
};
export const SCHEDULE_TRIGGER: RoutineTrigger = { kind: "schedule" };
export const TITLE_CONTAINS_MAX = 120;

export function isEventKind(kind: RoutineTriggerKind): kind is "task_event" | "run_event" {
  return kind === "task_event" || kind === "run_event";
}

export function triggerOf(task: { routineTrigger?: RoutineTrigger | null }): RoutineTrigger {
  const trigger = task.routineTrigger;
  return trigger && TRIGGER_KINDS.includes(trigger.kind) ? trigger : SCHEDULE_TRIGGER;
}

export function triggerForKind(kind: RoutineTriggerKind): RoutineTrigger {
  return isEventKind(kind) ? { kind, on: TRIGGER_ON[kind][0] } : { kind };
}

export function normalizeTriggerForSave(trigger: RoutineTrigger): RoutineTrigger {
  if (!isEventKind(trigger.kind)) return { kind: trigger.kind };
  const on = trigger.on && TRIGGER_ON[trigger.kind].includes(trigger.on) ? trigger.on : TRIGGER_ON[trigger.kind][0];
  const entries = Object.entries(trigger.filters ?? {})
    .map(([key, value]) => [key, typeof value === "string" ? value.trim() : value] as const)
    .filter(([key, value]) => Boolean(value) && (on === "status_changed" || (key !== "fromStatus" && key !== "toStatus")));
  const filters = Object.fromEntries(entries) as RoutineTriggerFilters;
  return entries.length ? { kind: trigger.kind, on, filters } : { kind: trigger.kind, on };
}

export function triggersEqual(a: RoutineTrigger, b: RoutineTrigger): boolean {
  return JSON.stringify(normalizeTriggerForSave(a)) === JSON.stringify(normalizeTriggerForSave(b));
}

/** The i18n key of the first problem the form must show, or null. */
export function triggerError(trigger: RoutineTrigger): string | null {
  const title = trigger.filters?.titleContains ?? "";
  return title.length > TITLE_CONTAINS_MAX ? "automation.errors.title_too_long" : null;
}
```

(Object key order: `normalizeTriggerForSave` must emit filters in a stable order for `triggersEqual`; sort `entries` by key before `Object.fromEntries` if a test shows order sensitivity.)

- [ ] **Step 5: Form state** in `taskBoardForm.ts`: add `routineTrigger: RoutineTrigger;` to `RoutineTaskFormState`, `routineTrigger: SCHEDULE_TRIGGER` to `emptyRoutineForm`, and `&& triggersEqual(a.routineTrigger, b.routineTrigger)` to the routine branch of `taskBoardFormsEqual`.

- [ ] **Step 6: List state and filter.**
  - `routine.ts`: add `| "listening"` to `RoutineState`; in `routineState` after the `paused` line: `if (triggerOf(routine).kind !== "schedule") return "listening";`; insert `"listening"` after `"scheduled"` in `ROUTINE_STATE_ORDER`; add `trigger: "all" | RoutineTriggerKind` to `RoutineFilters` and in `filterRoutineTasks`: `if (filters.trigger !== "all" && triggerOf(task).kind !== filters.trigger) return false;`.
  - `RoutineStateBadge.tsx`: `listening: "solid",` in `ROUTINE_STATE_SHAPE` (a resting state, like `scheduled`).
  - `RoutineChrome.tsx`: `trigger: "all"` in `initialRoutineFilters`; `trigger: { param: "trigger", allowed: TRIGGER_KINDS }` in `ROUTINE_FILTER_SPEC`; count it in `activeRoutineFilterCount`; add `"trigger"` to `ROUTINE_BAR_KEYS`; add the field `{ id: "trigger", label: t("automation.trigger"), kind: "select", options: TRIGGER_KINDS.map((kind) => ({ value: kind, label: t(`automation.kinds.${kind}`) })) }`.
  - `appRoute.ts`: in `LIST_FILTER_PARAMS.routines` add `trigger: new Set(["schedule", "task_event", "run_event", "webhook", "manual"]),` and add `"listening"` to the `state` set.
  - Any other `Record<RoutineState, …>` the compiler flags gets a `listening` entry.

- [ ] **Step 7: Strings.** Add to both locale files under a new top-level `"automation"` object, and `routine.states.listening`:

| Key | en | zh-CN |
|---|---|---|
| `routine.states.listening` | Listening | 监听中 |
| `automation.trigger` | Trigger | 触发器 |
| `automation.kinds.schedule` | Schedule | 定时 |
| `automation.kinds.task_event` | Task event | 任务事件 |
| `automation.kinds.run_event` | Run event | 运行事件 |
| `automation.kinds.webhook` | Webhook | Webhook |
| `automation.kinds.manual` | Manual only | 仅手动 |
| `automation.on` | When | 何时 |
| `automation.on_values.created` | A task is created | 任务被创建 |
| `automation.on_values.status_changed` | A task changes status | 任务状态变更 |
| `automation.on_values.completed` | A run completes | 运行完成 |
| `automation.on_values.failed` | A run fails | 运行失败 |
| `automation.filters_legend` | Only when | 仅当 |
| `automation.filter_any` | Any | 任意 |
| `automation.filter_project` | Project | 项目 |
| `automation.filter_agent` | Agent | 智能体 |
| `automation.filter_team` | Team | 团队 |
| `automation.filter_from_status` | From status | 原状态 |
| `automation.filter_to_status` | To status | 新状态 |
| `automation.filter_priority` | Priority | 优先级 |
| `automation.filter_title` | Title contains | 标题包含 |
| `automation.manual_hint` | Runs only when someone presses Run now. | 仅在有人点击“立即运行”时运行。 |
| `automation.webhook_url` | Endpoint | 端点 |
| `automation.webhook_header` | Send the secret in the {{header}} header. | 在 {{header}} 请求头中发送密钥。 |
| `automation.webhook_save_first` | Save the automation to get its webhook endpoint. | 保存自动化后即可获得 Webhook 端点。 |
| `automation.webhook_generate` | Generate secret | 生成密钥 |
| `automation.webhook_rotate` | Rotate secret | 轮换密钥 |
| `automation.webhook_configured` | A secret is set. Rotating it stops the old one immediately. | 已设置密钥。轮换后旧密钥立即失效。 |
| `automation.webhook_secret_once` | Copy this secret now. It will not be shown again. | 请立即复制此密钥，之后不会再次显示。 |
| `automation.webhook_copy` | Copy | 复制 |
| `automation.webhook_error` | Could not create a secret. Try again. | 无法生成密钥，请重试。 |
| `automation.rate_limited` | Paused after too many runs in an hour. Turn it back on when ready. | 一小时内运行次数过多，已暂停。准备好后可重新启用。 |
| `automation.ledger.schedule` | Scheduled | 定时 |
| `automation.ledger.task_event` | Task event | 任务事件 |
| `automation.ledger.run_event` | Run event | 运行事件 |
| `automation.ledger.webhook` | Webhook | Webhook |
| `automation.ledger.manual` | Manual | 手动 |
| `automation.errors.title_too_long` | Keep the title filter to 120 characters. | 标题筛选请不超过 120 个字符。 |

- [ ] **Step 8: Run, expect PASS** — `npx tsc -p packages/tsconfig.json && node --test dist/web/tests/automationTrigger.test.js dist/web/tests/taskBoardForm.test.js dist/web/tests/appRoute.test.js dist/web/tests/automationLabels.test.js dist/web/tests/i18nPlurals.test.js`, plus `npx tsc -p web/tsconfig.json --noEmit` (fix every place the new required `routineTrigger` form field is missing — `RoutinesPage.openRoutineForm` gets `routineTrigger: triggerOf(task)`).
- [ ] **Step 9: Commit.** `git add -A web && git commit -m "feat(web): model automation triggers"`

### Task 11: Trigger UI — drawer, webhook panel, list, ledger

**Files:**
- Create: `web/src/components/task-board/AutomationTriggerFields.tsx`, `web/src/components/task-board/WebhookSecretPanel.tsx`
- Modify: `web/src/components/task-board/TaskDrawer.tsx` (`RoutineSchedule`), `web/src/components/RoutinesPage.tsx` (`submitRoutine`), `web/src/components/task-board/RoutineRecords.tsx` (`nextRun` column), `web/src/components/task-record/RecordRuns.tsx` (`RunRow`), `web/src/api.ts`
- Test: interaction test only if `web/interaction-tests` already covers `TaskDrawer` (check `ls web/interaction-tests`); otherwise typecheck, lint, build, and the Task 10 tests are the gate, plus a manual check (Step 8).

**Interfaces:**
- Consumes: Task 10 model; `GET`/`POST /tasks/{id}/automation/webhook-secret` (Task 9).
- Produces: `webhookSecretStatus(taskId) -> Promise<{configured: boolean; path: string; header: string}>`, `rotateWebhookSecret(taskId) -> Promise<{secret: string; path: string; header: string}>` in `api.ts`.

- [ ] **Step 1: API client** in `web/src/api.ts` next to `startTask`:

```ts
export type WebhookSecretStatus = { configured: boolean; path: string; header: string };

export function webhookSecretStatus(taskId: string, signal?: AbortSignal): Promise<WebhookSecretStatus> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/automation/webhook-secret`, { signal });
}

export function rotateWebhookSecret(taskId: string): Promise<WebhookSecretStatus & { secret: string }> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/automation/webhook-secret`, { method: "POST" });
}
```

- [ ] **Step 2: `WebhookSecretPanel.tsx`** — the secret lives only in component state and is never cached:

```tsx
"use client";

import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { rotateWebhookSecret, webhookSecretStatus } from "../../api";
import { Button } from "../ui/Button";

/* The plaintext secret is shown once, straight from the mutation result, and
   never enters the query cache: a refetch must not be able to resurface it. */
export function WebhookSecretPanel({ taskId }: { taskId?: string }) {
  const { t } = useTranslation();
  const [secret, setSecret] = useState<string | null>(null);
  const status = useQuery({
    queryKey: ["automation-webhook", taskId],
    queryFn: ({ signal }) => webhookSecretStatus(taskId as string, signal),
    enabled: Boolean(taskId),
  });
  const rotate = useMutation({
    mutationFn: () => rotateWebhookSecret(taskId as string),
    onSuccess: (result) => {
      setSecret(result.secret);
      void status.refetch();
    },
  });
  if (!taskId) return <p className="adm-form-hint">{t("automation.webhook_save_first")}</p>;
  const info = status.data;
  const url = info ? `${window.location.origin}${info.path}` : "";
  return (
    <div className="webhook-panel">
      {info ? (
        <>
          <p className="adm-form-hint">{t("automation.webhook_url")}</p>
          <code className="webhook-panel-url">{url}</code>
          <p className="adm-form-hint">{t("automation.webhook_header", { header: info.header })}</p>
          {info.configured && !secret ? <p className="adm-form-hint">{t("automation.webhook_configured")}</p> : null}
        </>
      ) : null}
      {secret ? (
        <div className="webhook-panel-secret" role="status">
          <p>{t("automation.webhook_secret_once")}</p>
          <code>{secret}</code>
          <Button type="button" variant="outline" size="sm" onClick={() => void navigator.clipboard.writeText(secret)}>
            {t("automation.webhook_copy")}
          </Button>
        </div>
      ) : null}
      {rotate.isError ? <p className="adm-form-error" role="alert">{t("automation.webhook_error")}</p> : null}
      <Button type="button" variant="outline" size="sm" disabled={rotate.isPending} onClick={() => rotate.mutate()}>
        {t(info?.configured ? "automation.webhook_rotate" : "automation.webhook_generate")}
      </Button>
    </div>
  );
}
```

Match the real `Button` import path and variant names (`grep -rn "export function Button" web/src/components/ui`). Add `.webhook-panel*` styles in the stylesheet that owns `.routine-toggle` using existing tokens only (spacing, `--type-body-sm`, mono for `code`); no new colors (see the "Flat chrome" and "type consumption" memories).

- [ ] **Step 3: `AutomationTriggerFields.tsx`** — kind select plus the event `on`/filter fields:

```tsx
"use client";

import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Field } from "../ui/Field";
import { Input } from "../ui/Input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/Select";
import { TITLE_CONTAINS_MAX, TRIGGER_KINDS, TRIGGER_ON, isEventKind, triggerError, triggerForKind } from "../../lib/automationTrigger";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../lib/backlog";
import type { AgentTeam, EmployeeAgent, ProjectRecord, RoutineTrigger, RoutineTriggerFilters, RoutineTriggerKind, RoutineTriggerOn } from "../../types";

const ANY = "__any__";

type Props = {
  trigger: RoutineTrigger;
  agents: EmployeeAgent[];
  teams: AgentTeam[];
  projects: ProjectRecord[];
  onChange: (next: RoutineTrigger) => void;
};

export function TriggerKindField({ trigger, onChange }: Pick<Props, "trigger" | "onChange">) {
  const { t } = useTranslation();
  const labelId = useId();
  return (
    <Field label={t("automation.trigger")} labelId={labelId} wrapper="div">
      <Select value={trigger.kind} onValueChange={(value) => value && onChange(triggerForKind(value as RoutineTriggerKind))}>
        <SelectTrigger className="w-full" aria-labelledby={labelId}>
          <SelectValue>{(value: RoutineTriggerKind) => t(`automation.kinds.${value}`)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {TRIGGER_KINDS.map((kind) => (
            <SelectItem key={kind} value={kind} label={t(`automation.kinds.${kind}`)}>{t(`automation.kinds.${kind}`)}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function EventTriggerFields({ trigger, agents, teams, projects, onChange }: Props) {
  const { t } = useTranslation();
  const onId = useId();
  if (!isEventKind(trigger.kind)) return null;
  const filters = trigger.filters ?? {};
  const setFilter = (key: keyof RoutineTriggerFilters, value: string) =>
    onChange({ ...trigger, filters: { ...filters, [key]: value === ANY ? undefined : value } });
  const choice = (key: keyof RoutineTriggerFilters, label: string, options: Array<{ value: string; label: string }>) => (
    <FilterSelect key={key} label={label} value={(filters[key] as string | undefined) ?? ANY}
      options={[{ value: ANY, label: t("automation.filter_any") }, ...options]} onChange={(value) => setFilter(key, value)} />
  );
  const error = triggerError(trigger);
  return (
    <>
      <Field label={t("automation.on")} labelId={onId} wrapper="div">
        <Select value={trigger.on} onValueChange={(value) => value && onChange({ ...trigger, on: value as RoutineTriggerOn })}>
          <SelectTrigger className="w-full" aria-labelledby={onId}>
            <SelectValue>{(value: RoutineTriggerOn) => t(`automation.on_values.${value}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {TRIGGER_ON[trigger.kind].map((on) => (
              <SelectItem key={on} value={on} label={t(`automation.on_values.${on}`)}>{t(`automation.on_values.${on}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      {choice("projectId", t("automation.filter_project"), projects.map((p) => ({ value: p.id, label: p.name })))}
      {choice("assignedAgentId", t("automation.filter_agent"), agents.map((a) => ({ value: a.id, label: a.displayName })))}
      {choice("assignedTeamId", t("automation.filter_team"), teams.map((team) => ({ value: team.id, label: team.name })))}
      {trigger.on === "status_changed" ? (
        <>
          {choice("fromStatus", t("automation.filter_from_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
          {choice("toStatus", t("automation.filter_to_status"), TASK_STATUSES.map((s) => ({ value: s, label: t(`backlog.statuses.${s}`) })))}
        </>
      ) : null}
      {choice("priority", t("automation.filter_priority"), TASK_PRIORITIES.map((p) => ({ value: p, label: t(`backlog.priorities.${p}`) })))}
      <Field label={t("automation.filter_title")} error={error ? t(error) : undefined}>
        <Input name="automation-title-contains" maxLength={TITLE_CONTAINS_MAX + 20}
          value={filters.titleContains ?? ""} onChange={(event) => setFilter("titleContains", event.target.value)} />
      </Field>
    </>
  );
}

function FilterSelect({ label, value, options, onChange }: {
  label: string; value: string; options: Array<{ value: string; label: string }>; onChange: (value: string) => void;
}) {
  const labelId = useId();
  const labels = new Map(options.map((option) => [option.value, option.label]));
  return (
    <Field label={label} labelId={labelId} wrapper="div">
      <Select value={value} onValueChange={(next) => next && onChange(next)}>
        <SelectTrigger className="w-full" aria-labelledby={labelId}>
          <SelectValue>{(current: string) => labels.get(current) ?? current}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
```

Copy the exact import paths and the `Field`/`Input` props (`error`, `hint`, `wrapper`, `labelId`) from `TaskDrawer.tsx`'s existing imports; use the real constant names for status/priority lists and their i18n keys (`TASK_STATUSES` / `TASK_PRIORITIES` from `lib/backlog`, `backlog.statuses.*` / the key `PriorityBadge` uses). The project/agent/team options are filters only; an empty list just leaves "Any".

- [ ] **Step 4: Drawer.** Change `RoutineSchedule` to take `logicalAgents`, `teams`, `projects`, and render, in order: the existing type `Field`; `<TriggerKindField trigger={form.routineTrigger} onChange={(routineTrigger) => onChange({ ...form, routineTrigger })} />`; the cadence and next-run fields only when `form.routineTrigger.kind === "schedule"`; `<EventTriggerFields …/>`; `{form.routineTrigger.kind === "webhook" ? <WebhookSecretPanel taskId={form.id} /> : null}`; for `manual`, `<p className="adm-form-hint">{t("automation.manual_hint")}</p>`; then the existing enable toggle. When `form.routineDisabledReason === "rate_limited"` (add the optional field to `RoutineTaskFormState`, copied from the task in `openRoutineForm`) and the switch is off, show `t("automation.rate_limited")` as the toggle hint. Update the JSDoc on the component ("Everything that decides when an automation runs…"). Pass `logicalAgents`, `teams`, `projects` at the call site (`TaskDrawer.tsx:505`).

- [ ] **Step 5: Save.** In `RoutinesPage.submitRoutine` add `routineTrigger: normalizeTriggerForSave(form.routineTrigger),` to the payload, send `routineCadence` / custom `routineNextRunDate` only when the kind is `schedule`, and refuse to submit (return early, field already shows the error) when `triggerError(form.routineTrigger)` is non-null. In `openRoutineForm` add `routineTrigger: triggerOf(task)` and `routineDisabledReason: task.routineDisabledReason`.

- [ ] **Step 6: List column.** In `RoutineRecords.tsx` change the `nextRun` column header to `sortHead("nextRun", s.t("automation.trigger"))` and the cell to:

```tsx
        cell: ({ row }) => <RoutineCells.Read>{(s) => {
          const task = row.original;
          const kind = triggerOf(task).kind;
          if (kind !== "schedule") return <span className="task-trigger-label">{s.t(`automation.kinds.${kind}`)}</span>;
          return (
            <TaskDueCell
              date={task.routineNextRunDate}
              tone={routineDueTone(task)}
              format={formatNextRunDate}
              emptyLabel={s.t("routine.set_next_run")}
              onEdit={() => s.handlersFor(task).onEdit()}
            />
          );
        }}</RoutineCells.Read>,
```

- [ ] **Step 7: Ledger.** In `RecordRuns.tsx` `RunRow`, render `run.triggerKind` beside the date when present: `{run.triggerKind ? <span className="record-run-trigger">{t(`automation.ledger.${run.triggerKind}`)}</span> : null}` (style with existing muted text tokens).

- [ ] **Step 8: Verify.** `npx tsc -p web/tsconfig.json --noEmit`, `npm run lint -w web`, `npm run lint:css -w web`, `npx tsc -p packages/tsconfig.json && node --test dist/web/tests/*.test.js`, `npm run test:react -w web`, `npm run build -w web`. Then run the app (`make backend` + `make web`), and on `/automations`: create a Task-event automation (status → blocked), block an issue, wait one scheduler tick, and see the occurrence appear in the Runs tab labeled "Task event"; switch an automation to Webhook, generate a secret, `curl -X POST -H 'content-type: application/json' -H 'X-Relay-Automation-Token: <secret>' <endpoint> -d '{"ok":true}'` → 202, and see a "Webhook" run. Check zh-CN once via the language switch.
- [ ] **Step 9: Commit.** `git add -A web && git commit -m "feat(web): edit automation triggers and webhooks"`

### Task 12: Whole-branch verification

- [ ] **Step 1:** `npm test` (TypeScript + Python suites) → all pass. Paste the summary into the PR.
- [ ] **Step 2:** `cd backend && DATABASE_URL=sqlite:////tmp/relay-migrate.db make -C .. backend-migrate` (or the repo's equivalent) on a fresh database and on a copy with existing routines → both upgrade cleanly; existing routines read `routine_trigger_kind = 'schedule'`.
- [ ] **Step 3:** Grep for leftovers: `grep -rn '"/routines' web/src` → only the alias in `appRoute.ts`; `grep -rni "routine" web/src/i18n/locales/*/translation.json | grep -v '"routine\.' | grep -vi do_handoff` → only keys, no values.
- [ ] **Step 4:** Open the PR(s) per `git-workflow.md`: Phase 1 as one PR, Phases 2–3 as a second (or one PR per phase if review prefers), each with a test plan.
