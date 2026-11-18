# Task and Automation execution review

The journeys below were derived from the request to review execution for
standalone and Project Tasks and Automations. The review follows the HTTP
entry point through occurrence creation, scheduler admission, daemon command
delivery, recorded results, and the Task/run ledger.

## Execution guarantees

| Journey | Evidence |
| --- | --- |
| Computer-scoped standalone and Project Tasks run in their selected workspace and complete once | `backend/tests/api/test_task_automation_daemon_e2e.py` |
| Run now, due schedules, and authenticated webhooks create an occurrence, execute it, and expose its Thread and terminal timestamp in the definition's ledger | Same file |
| Occurrences retain their Automation source; the definition stays active and never acquires execution ownership | Both daemon test files |
| Project Workflows with no Team, legacy Team selections, and reusable Team-owned Workflows execute Tasks and manual/scheduled Automation occurrences | `backend/tests/api/test_workflow_daemon_e2e.py` |
| A missing required output blocks; owner retry and approval resume the same execution after a backend restart | Same file |
| Editing a definition does not change the frozen step order; retries retain one Task execution owner and one linked Thread | Same file |
| Cancellation stops the runtime without starting a successor; criteria-only steps retain evidence | Existing cases in the same file |
| Task assignment, Project navigation, standalone Workflow starts, and Automation previews remain usable on desktop and phone | `web/e2e/teamWorkflows.spec.ts`, `projectTasks.spec.ts`, `tasksWorkspace.spec.ts` |

The daemon tests use a disposable SQLite database, real loopback backend,
production scheduler wiring, and the built TypeScript daemon. Only the Agent
Runtime's output is deterministic. Schedule ticks are explicit; no background
timer races the test. Browser journeys use API fixtures and complement, rather
than replace, daemon delivery evidence.

## Findings

Real-daemon coverage previously exercised direct Workflow starts and one legacy
Team Task entry, leaving explicit no-Team Task selections and Automation
occurrences without equivalent recovery coverage. The expanded suite covers
those paths, Team ownership, and standalone Computer work.

Browser verification exposed stale expectations for separate Agents/Workflows
tabs after they became Collaboration and for global Project record links to
redirect. It also found incomplete Workflow and Thread queue fixture responses
that caused error screens. Fixtures now supply the actual response shapes;
Project navigation checks cover both global records and Project board drawers.
These browser failures were test-contract failures.

The review also verifies the preceding Project delegation/handoff repair,
merged as PR #853 during verification:
individual Project Tasks and Automation occurrences retain delegation candidates,
and both delegation admission/delivery and handoffs check enabled Project
membership. The full backend run validates those changes too. See
[the reproducer and coverage report](../testing/project-work-delegation.tdd.md).

## Verification

- Focused backend admission, scheduling, ownership, decisions and progression:
  108 passed.
- Combined real-daemon execution target: 21 passed.
- Full backend suite: 4,844 passed, 39 skipped. The final daemon target above
  additionally includes the five ownership/webhook cases added during that run.
- Built TypeScript suites: 3,315 passed.
- React interaction suite: 1,314 passed.
- Focused Workflow, Task and Automation browser journeys: 34 passed, following
  seven initial failures from stale selectors and incomplete fixtures.
- Complete production-export browser suite: 292 passed, including performance
  budgets. The same queue fixture correction also repairs recovery, next-step,
  status, Project Lead and route journeys in that suite. The phone independent
  Workflow run drawer was inspected from its captured screenshot.
- Production export: passed with `npm run build -w web -- --webpack`.
- Ruff: passed. Backend mypy: no issues in 503 source files.
- Official npm dependency audit: zero vulnerabilities. Installed Python
  dependency audit: no known vulnerabilities (the local Relay package is not
  published on PyPI and is excluded by the auditor).

The default `npm test` command stopped at Turbopack's CSS worker because this
environment denied its port bind, including the retry with local permissions.
The webpack export and individual test stages provide the verification instead.

The final execution and browser targets were:

```sh
backend/.venv/bin/pytest -c backend/pyproject.toml \
  backend/tests/api/test_workflow_daemon_e2e.py \
  backend/tests/api/test_task_automation_daemon_e2e.py -q -n 4
cd web
npx playwright test -c playwright.recovery.config.ts --workers=4
```

This follow-up changes tests and documentation only. It makes no schema,
production data, runtime, API shape, or dependency changes. Live model quality,
production infrastructure, and external webhook providers are outside these
deterministic tests. Existing event-trigger,
authorization, liveness and recovery tests remain part of the backend suite.
