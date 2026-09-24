# Team collaboration styles: backend continuation

Source: `docs/superpowers/specs/2026-09-24-team-collaboration-styles-design.md`
and `docs/superpowers/plans/2026-09-24-team-collaboration-styles.md`.

## Resume point and scope

Tasks 1–5 were committed before this continuation. Task 6 production changes
and initial tests were already in the working tree. Those edits were preserved
and validated, with additional dispatch regression coverage. Task 7 adds
regressions against the existing implementation; no registry change was needed.
Task 8 is next. The web controls and final feature documentation are unfinished.

Review also identified omissions in the remaining plan: shared task types and
event materialization need the field; client message operation keys need the
style; new-thread creation needs explicit override handling; historical turn
labels must use each run's frozen style rather than the latest round's style.
These corrections are recorded in the plan for the next continuation.

## Guarantees

| Plan task | Guarantee | Tests |
| --- | --- | --- |
| 6 | Task override wins over team style; absent override inherits; unstyled tasks default to Build → Review | `test_team_dispatch.py` task assignment tests |
| 6 | Style resolution precedes placement and preserves execution employee scoping | `test_task_dispatch_resolves_style_before_placement` |
| 6 | Project team tasks preserve their project snapshot and required computer while honoring style | `test_project_team_task_preserves_style_and_workspace` |
| 6 | Routine occurrences inherit Solo/Pipeline overrides and freeze them in manifests; absent style uses Build → Review | `test_scheduler_promotes_team_routine_into_team_owned_thread` |
| 7 | Reviewer findings repair the builder, then revalidate; two failed repairs require human attention; unused members do not block success | `test_build_review_repairs_findings_and_bounds_review_cycles` |
| 7 | Editing the team to Solo while its lead runs preserves the admitted Lead-led plan and policy, including duplicate completion handling | `test_lead_plan_is_authorized_persisted_and_replay_safe` |

## Evidence

This continuation did not observe the original Task 6 RED run. Its production
changes predated the session. Task 7's new regressions passed on the existing
implementation. Test fixture corrections (computer identity and the phase name
`execution`) were setup corrections, not production bug reproductions.

- Initial task dispatch, scheduler, task API, project API and team API run:
  **237 passed**.
- `uv run --project backend --extra dev pytest backend/tests/unit/test_daemon_registry.py backend/tests/api/test_team_routes.py -q -k 'build_review_repairs or lead_plan_is_authorized'`:
  **4 passed**, 363 deselected.
- `uv run --project backend --extra dev pytest backend/tests/unit/test_project_runtime.py backend/tests/unit/test_team_dispatch.py backend/tests/unit/test_task_scheduler.py -q`:
  **76 passed** after adding project/routing/routine cases.
- `npm test`: production package/web builds and TypeScript compilation passed;
  Node tests **1,734 passed, 2 failed**. Failures are the `composerTarget` source
  assertion and `designGrid` missing 1400px registry entry already documented
  in `work-outcomes.tdd.md`. This command stopped before React/Python.

- `npm run test:react -w web`: **301 passed, 5 failed**. The same four
  navigation assertions and roster timeout documented in `work-outcomes.tdd.md`
  recur; no frontend files were modified in this continuation.
- Coverage command (with `UV_CACHE_DIR=.uv-cache` and
  `COVERAGE_FILE=/tmp/relay-styles-backend.coverage`):

  ```sh
  uv run --project backend --extra dev --with pytest-cov pytest \
    backend/tests/unit/test_collaboration_styles.py \
    backend/tests/unit/test_team_dispatch.py \
    backend/tests/unit/test_project_runtime.py \
    backend/tests/unit/test_task_scheduler.py \
    backend/tests/api/test_team_routes.py \
    backend/tests/api/test_project_routes.py -q \
    --cov=relay.services.team_dispatch --cov=relay.services.project_runtime \
    --cov-report=term-missing
  ```

  **210 passed; 96% combined statement coverage** (`team_dispatch`: 99%,
  `project_runtime`: 91%). This is module coverage, not repository coverage.
- `git diff --check`: passed.

- `npx vitest run interaction-tests/rosterTabs.test.tsx` (from `web/`):
  **4 passed** in isolation; the full-run timeout remains recorded above.

- `npm run test:py`: **1,939 passed, 1 failed** in 504.88 seconds. The process
  had collected the new scheduler test before its assertion was corrected
  from `execute` to the actual `execution` phase. Production behavior was
  correct. The corrected scheduler module also passed in the 76-test and
  210-test runs above.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest --lf -q`:
  **1 passed** (the sole failed test). All 1,940 backend cases are thus verified
  across the full run and corrected rerun; a second complete run was not made.

No live model execution or browser acceptance test had been performed at this stage.

## Frontend continuation — 2026-09-25

Implemented plan Tasks 8–13 using the existing design-system select, field and
layout components: team default/role preview; task and routine overrides with
explicit inheritance reset; one-message composer override; frozen-round turn
labels, Solo fallback, repair-cycle and exhausted-budget notices; all three locales.
The first-message agent-run API now validates and forwards the style too.

The first-message API regression was observed RED (requested Solo admitted as
Build → Review) before the RunIntent/route propagation fix, then GREEN. Browser
fixture corrections (placement `desiredState: active`, populated `activeRuns`,
and dismissing the failure toast before retry) were test setup corrections.

- `npm test`: package/web production builds and TypeScript passed;
  **1,734 Node tests passed, 2 failed** (the same documented composerTarget and
  designGrid baseline failures). The command stopped before React/Python.
- `cd web && npx vitest run`: **317 passed, 5 failed**; the same four navigation
  assertions and roster timeout as the earlier baseline. Three additional
  helper tests were added afterward and passed in the focused run below.
- `npm run test:py`: **1,941 passed**, 604 warnings, 384.55 seconds.
- Focused team API and collaboration-conductor tests: **108 passed**.
- `cd web && npx vitest run interaction-tests/collaborationStyle.test.tsx
  --coverage --coverage.include=src/lib/collaborationStyle.ts`:
  **19 passed; 100% statements, branches, functions and lines** for this helper
  module. This is not repository-wide coverage. An earlier combined helper/UI
  coverage run missed the branch threshold; actual dropdown interactions are
  tested in Playwright instead of claiming jsdom coverage of the popup.
- Browser suite: `cd web && npx playwright test
  --config=playwright.recovery.config.ts e2e/collaborationStyles.spec.ts --workers=1`.
  **5 passed** in 6.4 seconds.
  Covers desktop/mobile team save and reload, task override/reset, composer
  send/reset, failed-send style/idempotency retention, and member-mention hiding.
  Uses mocked API responses; does not run real models or a live backend/daemon.
- `cd web && npx tsc --noEmit -p . && npx stylelint 'src/**/*.css'`: passed.
- `git diff --check`: passed.

Security review: the new first-message field uses the existing enum validator
and conductor team/purpose/address checks; existing authorization and dispatch
paths are unchanged. UI labels use React text rendering, with no HTML injection,
credentials, or new dependencies. No deployment or external mutation performed.

The remaining acceptance gap is Task 14's integrated backend + stub-daemon
browser sequence. Build/test results above must not be described as a fully
green repository suite or live-agent acceptance.
