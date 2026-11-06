# Backend asynchronous orchestration refactor

The source requirement is the backend refactoring goal: improve Python design,
organization, performance, and scalability. This report records one verified
part of that ongoing goal, not a claim that the entire backend has been audited.

## Journeys and guarantees

- Administrators can activate, check, and rotate chat integrations while other
  requests continue using the application loop. Provider calls stay asynchronous;
  successful rollback restores the old secret, and failed rollback retains the
  new secret as before.
- Users can publish/import skills, change revisions, and update metadata without
  synchronous authentication or store operations occupying the application loop.
- Users can upload images, start runs, and send messages while database work runs
  in workers. Access checks still happen before protected work.
- Project setup claims its draft and task in the same synchronous transaction,
  then dispatches asynchronously. Dispatch failure restores or fails only that
  draft and cleans up its unstarted task.
- Collaboration round preparation resolves persisted state in one worker phase;
  daemon dispatch stays on the loop and roster admission follows successful
  dispatch on a worker. Approval resumes retain their existing behavior.
- Workspace events authenticate in a worker before persisting their response and
  resolving the asynchronous query broker.

## RED and GREEN checkpoints

| Guarantee | RED evidence | GREEN evidence |
| --- | --- | --- |
| Chat authentication and stores run off-loop; provider operations stay on-loop | `e8501224`: seven executed cases failed at blocking authentication | `e0b54568`: 20 chat unit/API tests passed, including rollback and secret redaction |
| Skill mutations keep actual SQL off-loop | `51724ec0`: six operation cases; corrected import fixtures were rerun against the original implementation, all six failed on event-loop SQL | `6e261734`: all 32 skill API tests passed |
| Upload, message, startup, setup success and failure keep actual SQL off-loop | `9d655c50`: seven existing HTTP scenarios failed under the SQL thread guard | `0730a1c8`: seven guarded scenarios passed; the broader execution regression suite passed 158 tests |
| Setup has its own route module with the same access rules | Extraction followed GREEN | `c80ee38e`: 161 tests passed, including setup, collaboration, approvals, route authorization, layering, and size limits |
| Workspace-event authorization keeps SQL off-loop | `477c16b4`: the authorized workspace-event scenario failed under the SQL guard | Four daemon API regressions passed after the fix |

The SQL guard (`database_io_off_event_loop` in `backend/tests/conftest.py`)
instruments SQLAlchemy execution during real HTTP scenarios. It fails when a
synchronous statement runs in a thread with an active asyncio loop. The chat
unit tests separately check provider calls remain on the loop. Tests use local
stores and fake providers; none provisions a real external webhook.

## Verification

- Focused chat and skill coverage run: 48 passed; 82% statement coverage across
  their two runtime route modules.
- Focused execution coverage run: 161 passed; the extracted setup module had 93%
  coverage and collaboration orchestration has 81%.
- Final focused coverage run after the manifest cleanup fix: **210 passed**;
  1,251 statements, 242 missed, **81%** across eight runtime modules. Setup
  coverage is 94%. Individual module coverage ranges from 69% to 94%; this is
  combined coverage, not an 80% minimum for each module or the whole backend.
- Follow-up full API run: 1,293 passed.
- Follow-up full unit run: 2,410 passed, 10 skipped.
- Later changes were rerun through the 210-test focused coverage suite and the
  four workspace-event regressions.
- Initial full backend run: 3,695 passed, 12 skipped. The follow-up API/unit
  runs and final targeted reruns above cover changes made during that run.
- `npm run test:ts`: production build succeeded; 2,956 Node tests and 833 React
  tests passed.
- `uv run --project backend --extra dev ruff check backend`: passed.
- `cd backend && uv run mypy`: zero errors in 437 source files.
- `uv run --project backend --with pip-audit pip-audit --local`: no known
  vulnerabilities.

Focused commands (all use `uv run --project backend --extra dev`):

```text
pytest backend/tests/unit/test_chat_async_io.py backend/tests/api/test_chat_integrations.py backend/tests/api/test_chat_conversations.py -q
pytest backend/tests/api/test_skill_routes.py -q
pytest backend/tests/api/test_thread_attachments.py backend/tests/api/test_project_setup_api.py backend/tests/api/test_agent_api.py backend/tests/api/test_project_plan_api.py backend/tests/api/test_team_approval.py backend/tests/api/test_direct_delegation_api.py backend/tests/unit/test_collaboration_service.py backend/tests/unit/test_layering.py backend/tests/unit/test_module_size.py backend/tests/api/test_route_auth.py -q
pytest backend/tests/api/test_daemon_api.py -k 'workspace_event or daemon_run_events_leave or daemon_output_batch or heartbeat_is_authenticated' -q
pytest backend/tests/api -q
pytest backend/tests/unit -q
```

The final coverage run used the first two focused test groups (excluding
conversations) and execution group above together through
`uv run --project backend --extra dev --with coverage coverage run`, with
`--source` restricted to the eight runtime modules in the report.
`coverage report` produced the combined result. It measures the executed HTTP
and application/store interactions; no new browser flow was added.

Review also added a manifest-construction failure regression after extraction:
`ca24e6ee` reproduced a claimed draft left in `drafting` when manifest creation
raised. The fix `f5f1b327` performs synchronous cleanup before propagating that failure,
matching the earlier dispatch error path. The setup/plan/auth/architecture suite
then passed 49 tests, followed by the 210-test final coverage run.

## Organization and compatibility

`api/projects/setup.py` owns setup read/start handlers and their draft lifecycle.
`api/projects/access.py` owns the required owner-visible project lookup. The
general project-route module decreased from 591 to 364 lines. `create_app`
registers the setup router explicitly. No schema, public response, protocol, or
environment setting changed. Daemons still execute every agent run.

Synchronous work uses the existing bounded worker pool. Store mutation
transactions and their callbacks remain synchronous on one worker; they never
span a provider await. The follow-up [chat coordination change](backend-chat-coordination.tdd.md)
uses a separate, non-writing transaction only for provider coordination.
The round dispatch record makes the preparation/dispatch/admission phases
explicit without creating a second dispatch mechanism.

## Remaining scope

The overall refactoring goal remains active. This change proves thread placement
and behavior, not production throughput or replica safety for every aggregate.
Further review must cover:

- Chat document growth and history query bounds. The follow-up
  [chat coordination change](backend-chat-coordination.tdd.md) addresses the
  store/rotation replica races identified in this review, with live PostgreSQL
  evidence, while retaining the shared JSON document representation.
- Async application/background operations beyond the HTTP scenarios exercised
  here, database query bounds, and contention under concurrent load.
- PostgreSQL-specific behavior (the normal suite skips environment-dependent
  cases) and measurements of event-loop lag, pool wait, dispatch latency, and
  memory at the intended deployment load.

Existing architecture constraints and work bounds remain enforced by the
layering, module-size, reducer-isolation, performance, and scalability tests.
