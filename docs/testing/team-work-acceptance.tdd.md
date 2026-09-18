# Team work acceptance: validation evidence

Journeys were derived from the agent-team review and the user's request to
implement its recommendations. Design contract: [ADR-019](../adr/019-team-work-acceptance.md).

## Guarantees and regression evidence

| Journey / guarantee | Test area | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Team-specific responsibilities survive persistence, updates, and removal | `backend/tests/unit/test_team_store.py` | Missing `memberConfigs`; invalid configs accepted | Both local and database stores pass |
| Team role overrides the global default; lead owns final synthesis | `backend/tests/unit/test_team_dispatch.py` | Reviewer default overrode membership; missing synthesis turn | Dispatch tests pass |
| A required failed review cannot be overridden by the final `done` verdict | `backend/tests/unit/test_daemon_registry.py` | Task completed instead of waiting for human attention | Integration regression passes |
| Successful process exit is separate from accepted work | `backend/tests/unit/test_collaboration_work.py` | Work acceptance module absent | Missing/malformed evidence fails closed |
| Plans name authorized owners and concrete outputs, retain mandatory contributors, and survive duplicate delivery | `backend/tests/api/test_team_routes.py` | New contract exercised by API integration | Authorized plan persisted once; outside owner dispatch rejected |
| Findings return to the implementation owner, invalidate downstream evidence, and repeat review | Policy and daemon registry tests | Work repair policy absent | Full owner → review → repair → review → synthesis flow passes |
| Required findings reported by optional reviewers still block completion | `test_optional_reviewer_findings_on_required_work_cannot_be_ignored` | Completion returned no blockers | Required-work finding now blocks |
| Teammate questions have a bounded answer/resume path | Policy and daemon registry tests | Question transition absent | Answer turn and requester resumption pass |
| A consultation does not invalidate unchanged downstream work | `web/tests/collaborationWork.test.ts` | Answer-only attempt incorrectly made review stale | Explicit consultation projection preserves review status |
| Configured contracts cannot silently downgrade on an old daemon | Daemon registry tests | Unsupported daemon admitted configured work | Clear capability rejection before dispatch |
| Prompt predecessor context remains bounded | Policy tests | Context function absent | 18 large reports excerpted below 24,000 serialized characters |
| Editing teams preserves membership settings and removes deleted members | `web/tests/teamsView.test.ts`, React interaction tests | New fields missing from payload types/function | Payload and interaction tests pass |
| Event replay and SSE retain the same work evidence | `web/tests/sessionEvents.test.ts`, daemon registry integration | New projection contract | Shared replay, SSE, and Python persistence verified |
| Team configuration saves and survives reload in the browser | `web/e2e/teamCollaboration.spec.ts` | New browser journey | Playwright passes against production build with intercepted API fixtures |

The initial membership run produced **14 failures and 23 passes** before
implementation; the same scope plus conductor tests then passed **50 tests**.
The required-review bypass was reproduced as an actual incorrect task status.
The work-evidence transport test failed because the daemon parser discarded the
`work` object. The optional-review finding and consultation-staleness cases also
failed with the intended incorrect behavior before their fixes.

Local checkpoint commits retain RED/GREEN history. The frontend contract RED
checkpoint intentionally skipped only the two typecheck hooks because the new
interface did not yet exist; subsequent package/web compilation and full suites
run those checks normally. No production verification is waived by that RED
checkpoint.

## Validation commands

- `npm test` — production builds, TypeScript package/web tests, React tests, and Python suite.
- `npx playwright test -c playwright.recovery.config.ts teamCollaboration.spec.ts` (from `web/`).
- `COVERAGE_FILE=/tmp/relay-team-final.coverage uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_collaboration_work.py backend/tests/unit/test_team_store.py backend/tests/unit/test_team_dispatch.py backend/tests/unit/test_daemon_registry.py backend/tests/api/test_team_routes.py -q --cov=relay.collaboration.work --cov=relay.collaboration.contracts --cov-report=term-missing`.
- `npm audit --registry=https://registry.npmjs.org --json` — zero vulnerabilities. The configured mirror does not implement npm's audit endpoint; the public registry was used for this check without changing npm configuration.
- `uv run --project backend --extra dev --with pip-audit pip-audit --format=json` — no known vulnerabilities.
- `git diff --check`.

## Results and limits

The final full Python run passed **1,680 tests**. The final TypeScript run
passed **1,530 tests**; the React suite passed **82 tests** across 21 files.
The production build and the **one Playwright save/reload flow** passed.
`git diff --check` passed. Existing dependency/schema-reflection deprecation
warnings remain; no tests were skipped or failed in these runs.
Coverage of the new Python policy/validation modules was **89%** in the measured
382-test integration run. This is scoped coverage, not whole-repository coverage.
The browser test intercepts API responses; backend authorization, persisted
snapshots, daemon delivery, and replay are tested separately against real local
stores. No live paid model runs, cloud deployment, push, or third-party mutations
are part of this verification. Sequential execution and assignment-boundary
messaging are deliberate limits; no parallel shared-workspace safety is claimed.
