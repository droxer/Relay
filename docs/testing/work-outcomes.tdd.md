# Work outcomes: implementation and TDD evidence

## Scope and journeys

Derived from the agent/team harness review; decision: [ADR-020](../adr/020-work-outcomes.md).

- Single-agent action work must report evidence on capable daemons, like team work.
- Ending a process must not imply the requested problem was solved.
- A valid unfinished task can continue in its existing workspace and budget.
- Missing reports, findings, and human-review policies must remain effective gates.
- Outcomes must survive storage/replay/SSE/polling and clear on restart or cancel.
- Old execution records must not acquire verified or accepted status retroactively.

## RED evidence

- `4bc2718d`: 17 focused Python failures exposed missing single-agent work-report
  enforcement and outcome projection. TypeScript compiled; two web tests failed
  for missing outcome replay and the old “accepted” claim label.
- `86370f43`: the database summary omitted the outcome; six React cases rendered
  no outcome at all for a single-agent thread without a work graph.
- Additional executed regressions exposed continuation bypassing an unresolved
  finding, cancellation retaining the preceding outcome, historical snapshots
  lacking an unverified label, and a newer poll pairing its outcome with an old
  completion reason. Each was fixed and its focused target rerun.

## GREEN evidence

| Guarantee | Test target | Result |
| --- | --- | --- |
| Single-agent evidence gates, unfinished continuation, legacy/human acceptance, frozen protocol and downgrade refusal | `backend/tests/unit/test_daemon_registry.py` | Passed |
| Unfinished work cannot bypass missing reports, blockers or findings | `backend/tests/unit/test_collaboration_work.py` | Passed |
| Database summaries, replay, cancellation and human thread acceptance | `backend/tests/unit/test_session_store.py`, `test_controller.py` | Passed |
| Shared replay and SSE agree; newer polls cannot retain old completion reasons | `web/tests/sessionEvents.test.ts`, `sessionPollMerge.test.ts` | Passed |
| Claims are reported rather than accepted; stale work, legacy records and all outcomes render correctly | `web/tests/collaborationWork.test.ts`, `web/interaction-tests/teamResponsibilities.test.tsx` | Passed |

Commands run:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev --with pytest-cov pytest backend/tests/unit/test_daemon_registry.py backend/tests/unit/test_session_store.py backend/tests/unit/test_collaboration_work.py backend/tests/unit/test_controller.py --cov=relay --cov-report=json:/tmp/relay-harness-coverage.json -q --tb=short
npx tsc -p packages/tsconfig.json
npx tsc -p web/tsconfig.json --noEmit
node --test dist/web/tests/sessionEvents.test.js dist/web/tests/collaborationWork.test.js dist/web/tests/sessionPollMerge.test.js dist/packages/relay-core/tests/handoff.test.js
npm run test:react:coverage -w web -- interaction-tests/teamResponsibilities.test.tsx --coverage.include=src/components/CollaborationWork.tsx --coverage.include=src/lib/collaborationWork.ts
npm test
npm run test:py
npm run test:react -w web
git diff --check
```

- Focused Python: **333 passed**. Changed executable backend lines covered:
  **11/11**, intersecting the coverage JSON with added line ranges versus
  `0b894fc0`. This is changed-line coverage, not whole-backend coverage.
- Focused TypeScript: **124 passed**, including prompt/rendering regressions.
- Work panel React tests: **16 passed**; component and derivation coverage:
  **100% statements/functions/lines, 97.05% branches**.
- Full backend suite: **1,851 passed**, followed by focused validation of the
  later cancellation and capability-change regressions.
- Production build and package/web typechecks passed.

## Existing full-suite failures

`npm test` built successfully but stopped at two Node test failures:
**1,722 passed / 1,724 total**. Both were reproduced in an isolated archive of
the unchanged starting revision `0b894fc0`:

- `composerTarget.test.ts`: source regex expects a one-line runtime readout;
  the existing component has additional layout props.
- `designGrid.test.ts`: the existing 1400px breakpoint is absent from the
  palette registry.

The full React run had **307 passed / 312 total** at that point:

- Three `projectExecutionNavigation` failures and one `taskThreadNavigation`
  failure reproduced on the starting revision (missing navigation links).
- One `rosterTabs` test timed out at 60 seconds in the full run. Its complete
  four-test file passed separately on both the baseline and working tree.

The full suite is therefore not claimed green. No unrelated layout or navigation
code was changed to hide these failures.

## Dependency audit and limits

`npm audit` initially failed because the configured mirror has no audit endpoint;
the per-command official-registry retry reported **zero vulnerabilities** without
changing user configuration. `uv run --project backend --extra dev --with
pip-audit pip-audit` reported two existing advisories in **AnyIO 4.13.0**
(`CVE-2026-63374`, `CVE-2026-64847`; fixes reported in 4.14.2). Dependency upgrades
are not part of this change.

No live agent/provider execution, browser E2E run, paid jobs, or external writes
were used. Reports remain attributed claims. Independent daemon verification
receipts, durable problem records, adaptive delegation, and outcome evaluations
are the next stages documented in ADR-020.

There is no database migration. Event logs remain authoritative; the backend
does not execute agents. Existing task ownership fences, permissions, round
budgets, human acceptance policy, and daemon capability gates are preserved.
