# Handoff context and lifecycle evidence

Source: [handoff design and implementation](../agent-handoff-design-review.md).
The implementation keeps conductor-owned admission and daemon execution while
making the accepted context immutable and execution evidence explicit.

## Regression guarantees

| Guarantee | Evidence |
| --- | --- |
| Context uses durable event order despite clock skew | `test_handoff_context.py`: current objective and source boundary ignore timestamp ordering |
| Reports distinguish logical agents sharing an executor | Context test asserts the source logical identity alongside its report |
| Same-turn handoff notes remain historical context | Context test preserves an earlier handoff instruction |
| Prompt context is bounded and retains the latest result | Oversized objective/note/result tests assert the 24,000-character budget and omission indicator |
| A later large historical note cannot evict the latest result | Added test failed before reserving result space and passed after the fix |
| Prepared replay preserves accepted work | API test interrupts round persistence, adds a newer user message, and retries; stored context and dispatched objective remain unchanged |
| Decision, round, and receiver are linked | API test verifies `decisionId`, receiver identity, and the command's captured instruction |
| Staging is not execution | API and browser tests distinguish acceptance, command publication, and execution acknowledgement |
| Wrong run or missing/wrong current lease cannot acknowledge execution | API regression exercises the existing authorization boundary |
| Duplicate acknowledgements do not duplicate local delivery events | API regression submits the acknowledgement twice |
| Daemon acknowledgement precedes execution | Duplicate-command regression asserts one `run.executing` event before the agent runner executes |
| Core replay and browser SSE preserve context and lifecycle | `handoffStatus.test.ts` compares both projections |
| Old daemons and historical rounds remain usable | Browser tests cover output-based execution evidence and rounds without the context field; full legacy suites remain required |
| Old queued evidence cannot regress running state | Browser lifecycle regression replays delivery evidence |

## Focused commands

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_handoff_context.py backend/tests/api/test_team_routes.py -k 'handoff_context or recovery_dispatches_current_user_turn' -q
npx tsc -p packages/tsconfig.json
node --test dist/web/tests/handoffStatus.test.js
node --test --test-name-pattern='ignores duplicate run.start commands already active' dist/packages/relay-daemon/tests/daemon.test.js
```

Results: **12 Python tests passed**, TypeScript compilation passed, **4 browser
utility/replay tests passed**, and **1 focused daemon test passed**.

## Scope

No database migration or new credential flow is required. Existing cancellation
fences, admission idempotency fingerprints, assignment claims, authorization,
and placement/runtime checks remain authoritative. This change does not claim
new distributed serialization or repair historical partially recorded handoffs.
Live PostgreSQL schema tests remain environment-dependent. Autonomous delegation
and interruption followed by transfer remain separate features.

RED/GREEN evidence is recorded here; the implementation is submitted as one
reviewable change rather than separate checkpoint commits.

## Coverage

```sh
UV_CACHE_DIR=.uv-cache COVERAGE_FILE=/tmp/relay-handoff-context.coverage uv run --with coverage --project backend --extra dev coverage run --source=relay.sessions.handoff_context -m pytest backend/tests/unit/test_handoff_context.py -q
UV_CACHE_DIR=.uv-cache COVERAGE_FILE=/tmp/relay-handoff-context.coverage uv run --offline --with coverage --project backend --extra dev coverage report -m
```

**93% statement coverage** for the new context module (87 statements, 6 missed).
This is module coverage, not a claim of repository-wide coverage.

## Final repository verification

`npm test` passed after the final implementation and regression-test changes:

- Production web/package build passed.
- **1,400 compiled TypeScript tests passed.**
- **15 React tests passed.**
- **1,191 Python tests passed**, including the database schema checks available
  in the permitted full-suite environment; no tests were skipped in this run.
- `git diff --check` passed.

The build/integration suite required execution outside the filesystem sandbox
for its local worker ports and database access. The run reported four existing
Python deprecation/marker warnings and no failures.
