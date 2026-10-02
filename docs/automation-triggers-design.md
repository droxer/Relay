# Automation triggers design

Status: proposed (2026-10-02)

## Goal

Routines can only start on a time schedule. Extend them into **Automations**:
a recurring piece of work that starts when a trigger fires — a schedule, a
Relay event (task or run), an inbound webhook, or a manual "Run now". The
product surface is renamed from "Routines" to "Automations"; the storage and
wire names stay `routine*`.

### Decisions

| Question | Decision |
|---|---|
| Trigger kinds in v1 | schedule, Relay task/run events, inbound webhook, manual. GitHub-native triggers and chat triggers are later. |
| Rename depth | User-facing only: labels, titles, URLs. `routine*` fields, columns, events, and API payloads keep their names. |
| Automation shape | One trigger plus optional AND-ed filters. |
| Event context for the agent | Relay appends a structured "Trigger context" block to the occurrence description. No template variables. |
| Overlap policy | Coalesce: at most one pending run; events that arrive during a run collapse into the next one. |
| Event delivery | Transactional outbox written inside the store transaction, drained by the scheduler tick. |

### Invariants carried forward

- The backend never executes agents. Triggers only queue occurrences; the
  existing `promote_due_routine` → daemon dispatch path runs them.
- The event log is authoritative. Trigger configuration lives on
  `task.created` / `task.updated` events and replays into the snapshot.
- An automation's runs pass through `assertSessionOwnedByEmployee`, the
  same as every other run.

### Out of scope

- Multiple triggers per automation.
- Template variables in the description.
- GitHub HMAC signatures (`X-Hub-Signature-256`) and a GitHub App.
- Chat-message triggers.
- Changing what the routine type (Issue / Job) does — it stays a label.

## 1. Data model

An automation is still a routine task record (`isRoutine: true`). Assignment
(agent, team, or project), description, workspace layout
(`tasks/<routineId>/<taskId>/`), run ledger, and occurrence promotion are
unchanged. The trigger is added beside the existing `routine*` fields.

### Trigger field

New optional field on `task.created` and `task.updated`, replayed into the
snapshot by `store_common.py` like the other `routine*` fields:

```
routineTrigger: {
  kind: "schedule" | "task_event" | "run_event" | "webhook" | "manual",
  on?: "created" | "status_changed"     // task_event
     | "completed" | "failed",          // run_event
  filters?: {
    projectId?: string,
    assignedAgentId?: string,
    assignedTeamId?: string,
    fromStatus?: TaskStatus,            // task_event / status_changed; backlog | assigned | running | waiting_for_human | review | done | blocked
    toStatus?: TaskStatus,              // task_event / status_changed
    priority?: TaskPriority,            // "low" | "normal" | "high"
    titleContains?: string,             // ≤ 120 chars, case-insensitive
    fileExtension?: string              // run_event / completed, e.g. ".pdf"
  }
}
```

- A missing `routineTrigger` reads as `{kind: "schedule"}`. Existing
  routines keep using `routineCadence` / `routineNextRunDate` unchanged; no
  data migration.
- `routineCadence` and `routineNextRunDate` are meaningful only when the
  kind is `schedule`. Saving another kind clears `routineNextRunDate`.
- Any kind can also be run manually. `manual` means *only* manually.
- Filters are AND-ed and individually optional.
- The API validates against an allowlist: unknown keys, `on` values that do
  not belong to the kind, unknown project/agent/team ids, and over-length
  strings answer 400.
- A filter that names a project or team requires that the owner could assign
  work there (`project_task_assignment_error` and the team-on-computer rule).

### Occurrence stamps

Occurrences promoted by a trigger carry two more fields on their
`task.created` event:

- `routineTriggerKind` — the kind that fired.
- `routineTriggerDepth` — 0 for schedule/webhook/manual, otherwise the depth
  of the outbox row that fired it.

### Tables (one Alembic migration)

```
automation_outbox
  id                    uuid pk
  kind                  text      -- "task_event" | "run_event" | "webhook" | "manual"
  event_type            text      -- "task.created" | "task.status_changed" | "run.completed" | "run.failed" | "webhook" | "manual"
  source_type           text null -- "task" | "session"
  source_id             uuid null
  target_routine_id     uuid null -- set for webhook/manual (addressed), null for broadcast events
  payload               json
  origin_automation_id  uuid null
  depth                 int not null default 0
  created_at            timestamptz
  claimed_at            timestamptz null
  index (claimed_at, created_at)

automation_webhook_secrets
  routine_id   uuid pk fk tasks.id on delete cascade
  secret_hash  text      -- SHA-256 hex
  created_at   timestamptz

automation_state
  routine_id          uuid pk fk tasks.id on delete cascade
  pending             bool not null default false
  pending_events      json not null default '[]'   -- ≤ 20 entries
  pending_dropped     int  not null default 0
  pending_since       timestamptz null
  fired_window_start  timestamptz null
  fired_count         int  not null default 0
```

## 2. Matching and firing

### Outbox writes

`TaskStore.append_event` and `SessionStore.append_event` call
`automation_outbox.record(conn, event, context)` inside their existing
transaction. It writes nothing unless the event is on the allowlist:

| Store event | Outbox `event_type` | Payload |
|---|---|---|
| `task.created`, excluding routine definitions and occurrences | `task.created` | task id, title, status, priority, project/agent/team ids |
| `task.updated` where `status` changed | `task.status_changed` | the above plus `from`, `to` |
| session run completed | `run.completed` | session id, linked task id, logical agent id, generated file names |
| session run failed | `run.failed` | session id, linked task id, logical agent id, error summary (≤ 500 chars) |

Loop provenance: when the source task, or the task linked to the session, is
an automation occurrence, the row gets
`origin_automation_id = sourceRoutineId` and
`depth = occurrence.routineTriggerDepth + 1`.

The record function lives in `backend/relay/persistence/automation_outbox.py`
so both stores share one implementation.

### Matching (each scheduler tick)

A new step `drain_automation_outbox()` in
`backend/relay/tasks/automation_matcher.py`, called by `TaskScheduler` before
`_promote_due_routines`. It keeps `scheduler.py` from growing.

1. Claim up to `RELAY_AUTOMATION_OUTBOX_BATCH` (default 200) rows where
   `claimed_at` is null or older than 5 minutes, setting `claimed_at`.
2. Load enabled automations whose trigger kind is not `schedule` — one query
   per tick.
3. Match each row:
   - Addressed rows (`target_routine_id` set) match only that automation.
   - Broadcast rows match automations whose `kind` and `on` fit the
     `event_type`, then every filter, via pure functions in
     `backend/relay/tasks/automation_filters.py`.
4. Drop a match when any of these hold:
   - `origin_automation_id` equals the automation;
   - `depth > MAX_AUTOMATION_DEPTH` (3);
   - the source task is one of this automation's own occurrences.
5. Append the event to `automation_state.pending_events` (cap 20; overflow
   increments `pending_dropped`), set `pending = true`, set `pending_since`
   if unset.
6. Delete the claimed rows. Rows older than 7 days are pruned.

### Firing (same tick)

For each automation with `pending = true`:

- **Still running** (an occurrence is in flight — the `runningRoutineIds`
  rule, ported to the backend): leave it pending. This is the coalescing.
- **Rate cap reached** (`fired_count` within the current hour ≥
  `RELAY_AUTOMATION_MAX_RUNS_PER_HOUR`, default 6): append `task.updated`
  with `routineEnabled: false` and `routineDisabledReason: "rate_limited"`,
  then clear the pending state.
- **Otherwise:** promote an occurrence through `promote_due_routine`, with the
  Trigger context block appended to its description and the occurrence
  stamps set. Clear the pending state and increment `fired_count`, resetting
  the window when the hour has passed.

Trigger context block format:

```
---
Trigger context
Fired by: Task status changed (3 events, 1 more dropped)
- Task T-123 "Nightly import" — running → blocked
- Task T-130 "Sync billing" — running → blocked
- Task T-131 "Export CSV" — assigned → blocked
Webhook payload (JSON, truncated to 8 KB):
{ ... }
```

Schedule automations keep using `_promote_due_routines` unchanged. Their runs
can still trigger other automations; the depth limit bounds the chain.

## 3. API and web

### Webhook

`POST /api/v1/automations/{routineId}/webhook`

- Auth: `X-Relay-Automation-Token: <secret>`, hashed and compared in
  constant time. The secret is never accepted in the URL.
- JSON body only, ≤ 64 KB (413 / 415 otherwise). Rate-limited per automation
  through `security/rate_limit.py`.
- 401 on a bad or missing secret, 404 for an unknown routine, 409 when the
  automation is disabled or its kind is not `webhook`.
- On success, writes an addressed outbox row and answers
  `202 {"accepted": true}` without waiting for a run.

`POST /api/v1/tasks/{id}/automation/webhook-secret` creates or rotates the
secret and returns the plaintext once. Rotating invalidates the old secret
immediately. Owner or admin only. Changing the kind away from `webhook`
deletes the secret.

### Run now

`POST /api/v1/tasks/{id}/automation/run` with optional `{"note": string}`
(≤ 2 KB). Writes an addressed `manual` outbox row; subject to coalescing and
the rate cap. Owner or admin only. Works for every kind.

### Capability

`GET /admin/settings` (and the employee-visible settings payload) reports
`capabilities.automationTriggers`, driven by
`RELAY_AUTOMATION_TRIGGERS_ENABLED` (default on). With it off, the API
rejects non-schedule kinds and the web offers only Schedule.

### Web UI

- **Trigger section** in `TaskDrawer` replaces the "Schedule" fieldset:
  - a Trigger select: Schedule / Task event / Run event / Webhook / Manual
    only;
  - Schedule shows the existing cadence and next-run fields;
  - Task event and Run event show an `on` select and the filter fields
    (project, agent, team, status, priority, title contains, file
    extension), using the existing Select and roster pickers;
  - Webhook shows the endpoint URL, "Generate secret" (reveals the plaintext
    once with a copy button), and "Rotate secret".
- **Run now** button in the record header, with an optional-note popover.
- **Run ledger** labels each run with its trigger ("Webhook",
  "Task status → blocked · 3 events", "Manual: <note>"). A banner explains a
  rate-limit disable and offers "Re-enable".
- **List** gains a Trigger column and Trigger filter beside Type and Cadence.
  Cadence shows "—" for non-schedule automations.
- **Mirror module** `web/src/lib/automationTrigger.ts` holds trigger kinds,
  filter keys, and validation, mirroring the backend the way `routine.ts` and
  `taskAssignment.ts` do.

## 4. Rename: Routines → Automations

Shipped first, as its own PR, before any trigger work. User-facing only.

### Routes

- `/routines`, `/routines/<id>`, and `/routines/<id>/runs/<runId>` become
  `/automations/...` in `web/src/lib/appRoute.ts`.
- The old paths redirect to the new ones (replace, not push) so bookmarks
  and links in old threads keep working.
- Any `?tab` ids on the record join the canonical tab lists.
- The nav item, palette command, and `G` chord target `/automations`. The
  chord letter stays the same.

### Label text

Every user-facing string that says routine is updated in **both** `en` and
`zh-CN`. zh-CN uses 自动化 (count form: 个自动化). The keys stay as they are
(`routine.*`, `nav.routine`) so call sites don't change; only the values do.

Noun swaps:

| Key | en (new) | zh-CN (new) |
|---|---|---|
| `nav.routine` | Automations | 自动化 |
| `routine.title` | Automations | 自动化 |
| `routine.sub_one` / `sub_other` | {{count}} automation / automations | {{count}} 个自动化 |
| `routine.filters` | Automation filters | 自动化筛选 |
| `routine.new` | New automation | 新建自动化 |
| `routine.edit` | Edit automation | 编辑自动化 |
| `routine.search` | Search automations | 搜索自动化 |
| `routine.no_routines_title` | No automations yet | 暂无自动化 |
| `routine.no_match_title` | No matching automations | 没有匹配的自动化 |
| `routine.meta` | Automation status | 自动化状态 |
| `routine.delete_task` | Delete automation | 删除自动化 |
| `routine.delete_title` | Delete automation? | 删除自动化？ |
| `routine.toast_deleted` | Automation deleted. | 自动化已删除。 |
| `routine.select_all_routines` | Select all automations | 全选自动化 |
| `routine.bulk_delete_title_one` / `_other` | Delete 1 automation? / Delete {{count}} automations? | 删除 {{count}} 个自动化？ |
| `routine.toast_bulk_deleted_one` / `_other` | 1 automation deleted. / {{count}} automations deleted. | 已删除 {{count}} 个自动化。 |
| `routine.sort_label` | Sort automations | 自动化排序 |
| `routine.save` | Save automation | 保存自动化 |
| `routine.create` | Create automation | 创建自动化 |
| `thread.origin_routine` | Automation: {{title}} | 自动化：{{title}} |
| `thread.origin_kind_routine` | Automation | 自动化 |
| `backlog.runs.empty` | This automation has not run yet. | 该自动化尚未运行。 |
| `backlog.source_routine` | Automation runs | 自动化运行 |
| `record.not_found_body` | This issue or automation no longer exists. | 该议题或自动化已不存在。 |
| `record.run_not_of_routine` | This run belongs to a different automation. | 该运行属于其他自动化。 |
| `project.delete_confirm_message` | …all project issues, automations, conversations… | …所有议题、自动化、对话… |
| `routine.next_run_hint` (zh-CN only says 例行任务) | unchanged | 会在当天开始时运行，请选择今天或之后的日期。 |

Strings that assume every routine is scheduled are reworded for the trigger
model:

| Key | en (new) | zh-CN (new) |
|---|---|---|
| `routine.schedule` (fieldset legend) | Trigger | 触发器 |
| `routine.no_routines_body` | Create an automation to run work on a schedule or when something happens. | 创建自动化，按计划或在事件发生时运行工作。 |
| `routine.enabled_needs_target` | Select a project, agent, or team before enabling the automation. | 启用自动化前，请选择项目、智能体或团队。 |
| `routine.enabled_hint` | Disable to pause the automation and stop new runs from being dispatched. | 禁用后将暂停自动化，不再分派新的运行任务。 |
| `routine.delete_body` | “{{title}}” and its trigger will be deleted. It will not run again. All associated occurrences and threads will also be deleted. This cannot be undone. | 将删除“{{title}}”及其触发器，并且不会再次运行。所有关联的执行记录和话题也将一并删除。此操作无法撤销。 |
| `routine.bulk_delete_body_one` / `_other` | …selected automation(s) and their triggers will be deleted… | …所选的 {{count}} 个自动化及其触发器… |

Left alone on purpose:

- `login.do_handoff` ("routine updates") — plain English, not the feature.
- Schedule-only labels (`routine.cadence`, `routine.due`,
  `routine.unscheduled`, `routine.states.*`, `routine.next_run_auto_hint`)
  still describe the Schedule trigger and appear only for it.
- `routine.types.task` / `routine.types.job` (Issue / Job).

The implementation adds a web test that loads both locale files and fails if
any value under `nav.routine`, `routine.*`, `thread.origin_*routine`,
`backlog.*routine`, or `record.*` contains "routine" / "Routine" / 例行
(allowlisting `login.do_handoff`). This stops the old word from coming back.

New strings for the trigger UI (trigger kinds, `on` values, filter labels,
webhook, Run now, ledger labels, rate-limit banner) are added in both
locales as part of the trigger work.

### Docs

- `README.md` and user-facing docs (`docs/api.md`, `docs/deployment.md`)
  say Automations, noting that the API fields keep `routine*` names.
- The CLAUDE.md key invariants gain one line: `routine*` is the storage and
  wire name for automations, like `daemon-node`.
- README screenshots are regenerated with `script/readme-snapshots` if the
  Routines page appears in them.

## 5. Error handling

- An outbox write failure fails the store transaction. The event and its
  outbox row commit together or not at all.
- A tick that dies mid-match leaves rows claimed. Claims older than 5 minutes
  are taken again, so a crash costs a retry, not an event.
- A filter that cannot evaluate (bad stored data) is a non-match plus a
  warning log carrying the routine id.
- A promotion that fails (no assignee, project gate, offline node) goes
  through `_record_routine_skip`. Pending events stay pending; after 24 hours
  they are dropped and the drop is shown in the ledger.
- Every skip, coalesce, rate-cap disable, and depth drop is logged with the
  routine id and event type.

## 6. Testing

Python unit:

- Filter evaluation: every key, AND semantics, case-insensitive title match,
  unknown keys.
- Loop guards: self-origin, own occurrence, depth > 3.
- Coalescing: a burst during a running occurrence yields one run listing all
  events; overflow past 20 is counted.
- Rate cap: the 7th firing in an hour disables the automation with
  `routineDisabledReason: "rate_limited"`.
- Outbox allowlist: ineligible events write no row; routine definitions and
  occurrences are excluded from `task.created`.
- Stale-claim reclaim.
- Replay: a legacy routine with no `routineTrigger` reads as schedule.

Python API:

- Webhook: 202; 401 bad secret; 404 unknown; 409 disabled or wrong kind;
  413 oversize; 415 non-JSON; rotation invalidates the old secret; plaintext
  returned only once.
- Run now: owner/admin allowed, others 403; note length cap.
- Trigger validation: 400 for unknown keys, mismatched `on`, unknown ids,
  over-length strings; 400 for non-schedule kinds when the capability is off.

Integration:

- A task status change → scheduler tick → occurrence promoted with the
  Trigger context block → dispatched through the fake daemon path.

Web:

- `automationTrigger.ts` validation mirror.
- Trigger form round-trip in `taskBoardForm`.
- `/routines/...` → `/automations/...` redirects in `appRoute`.
- Locale guard test from section 4.
- Ledger trigger labels.

## 7. Delivery order

1. Rename PR: routes, redirects, label text (en + zh-CN), locale guard test,
   docs.
2. Backend: migration, outbox, matcher, firing, webhook and Run now routes,
   capability flag, tests.
3. Web: trigger section, Run now, ledger labels, list column and filter,
   mirror module, tests.
