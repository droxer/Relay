# Task execution reliability fixes: TDD evidence

Source: [task execution review](../reviews/task-execution-2026-11-18.md).
Journeys were derived from its three reproduced findings; no separate plan
file was used.

## Behavior and evidence

| User journey | Before | After and regression coverage |
| --- | --- | --- |
| A failed dispatch must not prevent later Tasks from starting. | A completed future holding `TimeoutError` was treated as pending forever. | Terminal exceptions propagate to dispatch-failure bookkeeping. The scheduler records the failed Task as blocked and dispatches the next Task; genuinely pending work keeps waiting. |
| The next Agent must receive the previous Codex reply. | Raw `item.completed` / assistant-message frames became `<no output>`. | Bridge, conversation history, and immutable handoff context retain the latest answer and ignore tool, user, unfinished, and malformed records. A real backend/daemon follow-up also receives the previous reply. |
| A long reply's opening and final answer must remain available in fallback logs. | Capture and log assembly both discarded the beginning above 262,144 characters. | Both use one bounded opening-and-tail policy with a visible omission marker. Truncated JSONL records are omitted at the gap rather than emitted as fragments. Tests cover one-character, uneven, and single-chunk delivery, an oversized middle frame, and unchanged output up to the cap. |

RED checkpoint: `16eee24f` (`test: reproduce task execution reliability failures`).
Python: **3 failed, 3 passed**; the failures were the timeout and two Codex reply
shapes. TypeScript: **5 failed, 1 passed**; capture and completed logs lost the
opening reply. Both suites compiled/executed before runtime changes.

GREEN checkpoint: `c099fad3` (`fix: preserve task progress and agent transcript continuity`).
The same regression seams pass; expanded focused suites pass **70 Python** and
**111 TypeScript** tests. Checkpoint hashes refer to the PR branch after rebasing
onto `origin/main`.

## Validation commands

Focused backend and coverage:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_execution_review_regressions.py backend/tests/unit/test_bridge.py backend/tests/unit/test_conversation.py backend/tests/unit/test_handoff_context.py backend/tests/unit/test_task_scheduler.py --cov=relay.sessions.bridge --cov=relay.tasks.scheduler --cov-report=term-missing --cov-fail-under=80 -q -n 0
```

Result: **70 passed**, combined module coverage **82.79%** (bridge 88%, scheduler
80%). `pytest-cov` was supplied temporarily; project dependencies did not change.

TypeScript regression seams, after package builds and `npx tsc -p packages/tsconfig.json`:

```sh
node --test dist/packages/relay-daemon/tests/transcript-retention.test.js dist/packages/relay-core/tests/handoff.test.js
node --experimental-test-coverage --test-coverage-include='**/relay-core/dist/transcript.js' --test-coverage-lines=80 --test-coverage-branches=80 --test-coverage-functions=80 --test dist/packages/relay-daemon/tests/transcript-retention.test.js
```

Final result: **113 passed**, including added small-cap and Unicode boundary
checks. Transcript module coverage: **96.63% lines, 91.18% branches, 100%
functions**. Coverage report names `packages/relay-core/dist/transcript.js`;
it covers the imported implementation, not an empty source filter.

Real backend/daemon E2E:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/api/test_daemon_report_e2e.py backend/tests/api/test_daemon_connection_e2e.py backend/tests/api/test_workflow_daemon_e2e.py -q -n 0
```

Result: **25 passed**, including the added Codex follow-up context regression.
This exercises actual HTTP, persistence, daemon dispatch, streaming, completion,
and follow-up construction with a deterministic Agent Runtime.

Full repository verification: `npm test` exited **0**. Node suites: **3,321
passed**; React suites: **1,314 passed across 200 files**; Python suites: **4,837
passed, 34 skipped**. The final PostgreSQL checks completed; the run was not
abandoned at 99%. The two additional small-cap/Unicode tests were also verified
by the final 113-test targeted TypeScript run. `npm run build` passed again on
the rebased PR branch, including the computer installer and production web
export. `git diff --check` passed.

Other checks: targeted Ruff passed; backend mypy passed with **zero issues in
503 source files**. npm and Python dependency audits found **no known
vulnerabilities**; the local `relay` package has no PyPI audit entry. Pre-commit
checks on both checkpoint commits passed, including package typechecking.

## Boundaries

The backend continues to queue execution through Daemon Nodes; reservation,
lease, authentication, and task-acceptance rules are unchanged. No API, event,
or database migration is required. Deploy the backend continuity/scheduler fixes
and update Computers for the new daemon transcript retention policy.

The transcript cap remains per stream, in characters. Data beyond it is still
omitted; a single JSONL record too large to fit the retained regions may be
omitted completely. Live output delivery is unchanged. Tests do not certify a
live model provider, installed runtime authentication, or native BoxLite.
