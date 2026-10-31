# Home enrichment: implementation and design review

The brief was agreed in conversation: personal, action-first Home, relevant
shared dependencies, today plus seven days, one explained recommendation,
user-controlled execution, existing admin-console colors, and truthful source
states. No AI briefing, automatic execution, charts, or custom widgets.

## Guarantees and evidence

| Behavior | Evidence | Result |
| --- | --- | --- |
| Direct dependency summaries expose only allowed metadata in an accessible project; full task access stays protected | `backend/tests/api/test_task_prerequisites_api.py::test_list_dependency_summary_respects_project_access` | RED: missing `waitingOnSummaries`; GREEN: 7 API tests pass, including responsible display name, no description/events, forbidden detail read, and withheld foreign-project metadata |
| Ready work excludes other users, intake, unknown/open prerequisites, routines, queued work, and closed projects; ordering uses priority/date | `web/tests/homePlan.test.ts` | RED: new module/contract missing; GREEN: 4 rule tests pass |
| Upcoming uses local calendar days, deadlines, existing scheduled runs, and active automations' next known fire | `web/tests/homePlan.test.ts` | PASS; no client cron/DST reimplementation |
| A focused item is rendered once and never produces a false global-clear statement | `web/e2e/home.spec.ts` | PASS |
| Ready lists expand without losing their readiness filtering | `web/e2e/home.spec.ts` | PASS |
| Starts preserve queued outcomes, prevent duplicate submission, and permit retry after a network failure | Home E2E and `web/interaction-tests/homeDashboard.test.tsx` | PASS |
| Failed source reads show Retry, not a clear queue | Home E2E | PASS |
| Phone users can jump to deadlines/running work after the recommendation | Home E2E and independent browser reproduction | PASS |

Commands/results:

- `node --test --experimental-test-coverage --test-coverage-include=dist/web/src/lib/homePlan.js dist/web/tests/homePlan.test.js`: 4 passed; 100% lines/functions, 82.46% branches for the rule module.
- Home/routing design regression unit selection: 38 passed.
- Home and relay-data-refresh React selection: 5 passed.
- Home Playwright suite: 11 passed, including both themes and phone layout.
- Production web build with `--webpack`, backend mypy (384 source files), changed-source Ruff/ESLint, Stylelint, and diff whitespace checks passed. Turbopack's CSS worker could not bind its local port in this environment.
- Full backend: 3312 passed, 32 skipped, three controlling-terminal installer tests failed in the sandbox. All three passed when rerun outside the sandbox.
- Broad compiled web/core suite: 2211 passed; three source assertions still fail against unchanged favicon, provisioning, and routine-start code (`brandIdentity`, `provisionDrawers`, `taskBoardReviewFixes`). The mobile header assertion was updated to recognize Home's intentional header exception and now passes.
- Full React suite: 737 passed, one roster-keyboard test timed out. Its four-test file passed on an isolated rerun.

The pure-rule coverage measurement is scoped; it is not a claim of whole-feature
or repository coverage. No new database migration is needed for enrichment.
The PR's earlier nullable Account snooze migration remains required.

## Independent Impeccable critique

Assessment A: `/root/home_design_a` (design/usability). Assessment B:
`/root/home_design_b` (detector attempt and browser measurements). They used
fresh independent browser pages and did not share findings; B's report was
read only after A finished.

Specificity: Relay's human decisions, agent execution, prerequisites, and
computer readiness determine the composition. The page retains the admin data
palette and existing task/thread write paths.

A scored the initial implementation 28/40. The final verified score is 30/40
(Good): visibility, real-world match, control, consistency, prevention,
recognition, efficiency, aesthetics, recovery, and help each scored 3/4.

Priority findings fixed and independently verified:

1. A lone focused permission no longer renders a contradictory all-clear.
2. Ready counts have matching Show all / Show less disclosure.
3. Mobile Running / Upcoming / Shared blockers links follow the recommendation
   and jump directly to their sections.
4. All mobile buttons and section/footer/context links meet the measured
   44px height baseline; all buttons also measure at least 44px wide.

Measured desktop/phone light/dark horizontal overflow: 0px. The scoped colored
text checks measured at least 5.19:1 light and 5.93:1 dark. Compact inline text
links remain text links; this is not a blanket WCAG certification. Long queue
explanations still use a preview; opening the source record provides context.
The failed-source view intentionally withholds recommendations until its
inputs can be checked, including when some sources remain healthy.

The deterministic detector and canonical snapshot storage were unavailable:
engine 0.1.16 was not installed and the launcher could not write its cache;
an overlay-server attempt also refused an unverifiable engine download. No
clean detector result, live overlay, target slug, or canonical snapshot is
claimed. There was no ignore list. Browser fallback used Playwright because
the native browser host was unavailable. All review browsers were closed and
the parent-owned static server was stopped after final verification.

Review fixes are covered above; questions were skipped because the agreed
scope was implemented and the actionable findings were resolved.
