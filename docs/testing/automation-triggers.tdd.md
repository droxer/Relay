# Automation triggers: implementation and verification

Source plan: [automation-triggers-plan.md](../automation-triggers-plan.md).
Design: [automation-triggers-design.md](../automation-triggers-design.md).

## Delivered behavior

Existing routines remain schedule automations. Employees can configure task
or run events with filters, inbound webhooks, or manual-only execution through
the Automations drawer. Events create real occurrence tasks through the
scheduler and existing daemon dispatch path. The backend never runs agents.

The continuation starts after Tasks 1–7 (`32b5c712`); Tasks 8–11 add matching,
coalescing, bounded context, expiry, rate-cap pauses, webhook authentication,
secret rotation, trigger filters, listening state, and run ledger labels.

The plan's sample code was treated as implementation guidance and adapted to
actual store signatures and existing UI primitives. Verification used the
repository's pytest, node:test, Vitest, TypeScript, ESLint, and Stylelint
commands. No embedded install commands or remote-agent instructions were run.
The referenced superpowers workflow is unavailable here; the installed TDD
workflow supplied the test-first implementation and local checkpoint commits.

## RED/GREEN evidence

| Behavior | RED evidence | GREEN guarantee |
| --- | --- | --- |
| Task 8 matcher | `acc65f7b`: missing `relay.automations.matcher` | Matching events create occurrences; nonmatches and self-loops do not |
| Firing rollback | `fd9677c9`: interrupted firing left an occurrence persisted | Outbox consumption, pending state, occurrence and rate-window changes roll back together |
| Task 9 webhooks | `04cf7089`: seven endpoint tests returned 404 | Authenticated JSON requests queue; tokens rotate; pause rejects calls; access and body limits apply |
| Task 10 model | `27655091`: missing trigger module and task fields | Trigger normalization, form defaults, equality, listening state and URL filters work |
| Task 11 drawer/replay | `4675ec6c`: three drawer tests failed and replay dropped trigger fields | Drawer renders kind-specific fields and TypeScript replay retains configuration and provenance |
| Scheduled/manual labels | `a01254ef`: occurrences lacked `routineTriggerKind` | New scheduled and manual occurrences carry their actual trigger kind |
| Empty webhook body | `7b3bb9a0`: empty JSON request was accepted | Empty body returns 400 and queues nothing |
| Concurrent matchers | `767588a3`: two PostgreSQL schedulers created two occurrences | A transaction advisory lock allows only one matcher per database to fire shared pending state |

The intentionally failing model checkpoint skipped only the TypeScript commit
hooks; all other hooks ran. Later typechecks and complete web unit tests passed.
The broader checks also found stale rename expectations in form, URL-filter and
project deletion tests; these now expect Automations.

## Test specification

| Guarantee | Test target | Type |
| --- | --- | --- |
| Matching task events fire, bursts coalesce, pending entries cap at 20 and expire | `backend/tests/unit/test_automation_matcher.py` | Store integration |
| Own occurrences and deep chains do not refire; review does not hold events | Same matcher tests | Regression |
| Hourly cap pauses the routine; disabled/deleted definitions discard pending state | Same matcher tests | Regression |
| Run events use linked-task filters and preserve loop provenance | Same matcher tests | Store integration |
| Scheduler tick creates triggered occurrences | Same matcher tests | App integration |
| Webhook auth, JSON/size validation, paused refusal, secret rotation/access and rate limiting | `backend/tests/api/test_automation_webhook.py` | HTTP integration |
| Webhook → scheduler tick → occurrence → labeled API ledger | Same webhook tests | API workflow |
| All occurrence kinds retain provenance | `backend/tests/unit/test_triggered_occurrence.py` | Database/local parity |
| Two PostgreSQL matchers cannot double-fire; legacy routines survive migration roundtrip | `backend/tests/unit/test_schema_drift.py` | PostgreSQL integration |
| Normalization, equality, form dirty state, listening state, route filters | `web/tests/automationTrigger.test.ts`, `taskBoardForm.test.ts`, `appRoute.test.ts`, `routine.test.ts` | Unit |
| Shared TypeScript event replay retains trigger fields without mutating the original event | `web/tests/automationReplay.test.ts` | Unit |
| Drawer renders each kind, validates title filters, and renders webhook/manual hints | `web/interaction-tests/routineDrawer.test.tsx` | Interaction |
| Secret lives only in component state and disappears on unmount | `web/interaction-tests/webhookSecret.test.tsx` | Interaction |

## Verification

- `npx tsc -p packages/tsconfig.json` and
  `npx tsc -p web/tsconfig.json --noEmit`: passed.
- Complete compiled TypeScript suites: 1,813 passed (including 1,371 web tests).
- Initial `npm run test:react -w web`: 385 passed. Final focused drawer/secret
  interaction target: 13 passed, including the title-filter accessibility fix.
  Final complete React suite: **386 passed across 63 files**.
- `npm run lint -w web`, `npm run lint:css -w web`, `git diff --check`: passed.
- `npm run build -w web -- --webpack`: passed, including static prerender/export.
- `npm test` was attempted but its default Turbopack build fails when the CSS
  worker binds a port (`Operation not permitted`), including an escalated run.
  Build and the constituent complete test suites were verified separately.
- Final complete Python suite with disposable PostgreSQL: **2,083 passed**.
  The additional legacy-migration regression passes in the PostgreSQL target
  (**12 passed**) after it was added following full-suite collection.
- The first sandboxed Python run: 2,067 passed, 10 skipped, one failure in
  `test_token_prompt_uses_controlling_tty_with_piped_stdin`. The entire installer
  target passes outside the sandbox (15 passed). Final Python results below use
  local process access and disposable PostgreSQL.
- Fresh PostgreSQL `alembic upgrade head`: passed. Existing pre-trigger routine
  upgrade: passed, including `routine_trigger_kind = 'schedule'`, unchanged next
  date and event history. Downgrade to `20260924_0080` then upgrade: passed.

## Coverage and limits

`UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev python
 docs/testing/repros/automation-trigger-coverage.py` runs the focused tests
while tracing executable lines on both the main thread and FastAPI workers.
It needs no extra dependency. It measures line coverage, not branch coverage.

| New module | Executable lines covered |
| --- | --- |
| `automations/trigger.py` | 91.1% |
| `automations/matcher.py` | 90.2% (PostgreSQL advisory-lock branch separately tested) |
| `persistence/automation_store.py` | 98.7% |
| `api/automation_routes.py` | 91.3% |

No live agent or external webhook provider was invoked. The API workflow test
verifies firing and ledger presentation; existing daemon execution tests verify
the execution path. Dependency audit could not reach the configured npm mirror
(`ENOTFOUND registry.npmmirror.com`); no dependency files were changed.

## Review packet

- Main surfaces: `automations/matcher.py`, scheduler/app wiring, automation
  routes, task occurrence/ledger fields, shared task contracts/replay, web
  drawer/filter/list/ledger UI and locale strings.
- Authoritative events remain the source of configuration and occurrence state;
  outbox/state changes commit with firing, and PostgreSQL matchers serialize
  using a transaction-scoped advisory lock.
- Existing migrations `0081`/`0082` must run before starting the new backend.
  No data rewrite of old event logs is required; old routines default to schedule.
- Hashes are stored, plaintext is returned once, never cached in the browser,
  and secret management uses record access plus owner/admin checks (tightened during review).
- Webhook rate limiting remains process-local; replica deployments need an
  edge limiter. Pending events and retained context are bounded as in the plan.
- Local commits preserve RED/GREEN history. Nothing was pushed or published.

## Final local checkpoints

- `ad9f4f7f`: initial matcher/scheduler/webhook GREEN implementation.
- `786c35e1`: trigger types, normalization, form/list/URL model.
- `b65d313c`: final backend GREEN, including advisory-lock concurrency,
  validation, occurrence labels, and workflow/migration regressions.
- The final web/UI and documentation commit follows these checkpoints and
  includes the passing complete React suite and production build.


## Design review fixes (2026-10-03)

The six review findings are fixed in both the plan and implementation. The
owner boundary now applies to filter scopes, broadcast matching, manual starts,
and webhook secret management. Manual starts share the transactional matcher
and cap; automatic pending events cannot fire a manual-only definition.
Occurrence creation events persist structured trigger summaries for replay and
ledger labels. The ledger offers direct rate-limit recovery, and re-enabling
atomically resets the rate window under the matcher lock.

| Finding / guarantee | Regression target | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Filter scopes require the owner's assignment access; admin cannot bypass it | `test_automation_triggers_api.py` | `574514c0`: foreign project filter accepted | Owner project/agent/team checks, create/PATCH parity, and team/computer gate pass |
| Unfiltered automation cannot observe another employee's private work | `test_automation_matcher.py` | `b99f4d7f`: foreign task fired Alice's automation | Owner/assignee visibility enforced before matching |
| Switching to Manual only discards automatic pending events | `test_automation_matcher.py` | `574514c0`: matcher fired one unrequested occurrence | No occurrence; pending state cleared |
| Malformed stored filter is isolated and warned | `test_automation_matcher.py` | `574514c0`: AttributeError aborted the tick | Good automation still fires |
| Non-owner assignee cannot read secret status or rotate it | `test_automation_webhook.py` | `574514c0`: Bob received 200 | Owner/admin boundary enforced |
| Manual requests coalesce and share the hourly cap for all trigger kinds | Matcher/API trigger tests | `9bd4f63c`: missing manual outbox; API counter stayed zero | Cap pauses the automation; running requests coalesce |
| Re-enable permits immediate firing in a fresh rate window | API trigger test and record interaction test | `b99f4d7f`: re-enabled automation immediately paused again | Fresh firing succeeds; button invokes PATCH |
| Ledger summaries survive authoritative event replay | `test_automation_matcher.py` | `9bd4f63c`: missing summary | Status/event count survives replay and ledger serialization |
| Ledger identifies task-created/run-completed/run-failed events | `taskRecord.test.tsx` | `93a07fac`: three missing labels | All 12 record interaction tests pass |
| Concurrent manual/scheduled-manual matchers produce one occurrence and one rate increment | `test_schema_drift.py` | Shared-lock regression expanded to manual requests | All 14 PostgreSQL checks pass |

Compatibility checks preserve overdue schedule advancement, immutable queued
occurrence assignments, existing active-thread responses, and daemon-only
execution. Manual starts after review/blocked create a fresh ledger row instead
of rewriting completed or failed history; existing expectations were updated
for this specified behavior.

Final validation:

- Full backend: `RELAY_TEST_DATABASE_URL=postgresql+psycopg://relay:relay@127.0.0.1:55439/relay UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest -q --tb=short`
  — **2098 passed**, no skips. Two additional parametrized manual concurrency
  cases were subsequently validated in the **14-pass** schema target.
- Compiled TypeScript/package/web node tests — **1813 passed**, no skips.
- `npm run test:react -w web` — **391 passed / 63 files**.
- `npm run build -w web -- --webpack` — production build and static export pass.
- Package/web TypeScript checks, ESLint, Stylelint, and `git diff --check` pass.
- Coverage helper — **68 focused tests pass**; executable-line coverage:
  trigger **94.5%**, matcher **89.9%**, automation store **98.7%**, webhook routes
  **92.8%**. PostgreSQL advisory-lock paths are verified separately.

`npm test` still fails at the default Turbopack build because the sandbox denies
its worker-port bind. Its constituent suites and the webpack production build
pass with their required local permissions. `npm audit` could not resolve the
configured npm mirror (`ENOTFOUND registry.npmmirror.com`). No dependency files
were changed. No live agent or external webhook provider was invoked, and
nothing was pushed or published.
