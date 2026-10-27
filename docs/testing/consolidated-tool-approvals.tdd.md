# Consolidated tool approval evidence

The user requested one transcript entry for a Bash action and its approval.
Journeys were derived from that request and the review findings; no plan file
was supplied.

## Guarantees and regression evidence

| Guarantee | Test | RED | GREEN |
| --- | --- | --- | --- |
| Permission outcomes join the agent turn that requested them | `web/tests/messageBlock.test.ts` | Existing implementation from the handed-off session | All 33 projection tests pass |
| Codex commands with translated `item_N` ids receive their approval suffix | `web/tests/permissionAudits.test.ts` | 1 of 7 placement tests failed: approval remained unplaced | All 7 placement tests pass |
| Exact call ids take precedence and different native tool calls stay separate | `web/tests/permissionAudits.test.ts` | Guard tests passed before the fix | Guard tests remain passing |
| Every allow variant exposes the full multiline Bash command on its own tool row | `web/interaction-tests/permissionAudits.test.tsx` | All 3 React tests failed: tooltip contained only the label | All 3 React tests pass |
| Warning styles consume the shared tone driver | `web/tests/toneDriver.test.ts` | The new warning rule incorrectly read `--warn` directly | All 6 tone tests pass after using `--tone` |

## Commands and results

- `npx tsc -p packages/tsconfig.json`: passes.
- `node --test --experimental-test-coverage dist/web/tests/permissionAudits.test.js dist/web/tests/messageBlock.test.js`:
  40 passed. Placement coverage: 97.96% lines, 87.88% branches, 100% functions.
  These focused tests do not measure repository-wide coverage.
- `npm run test:react -w web -- interaction-tests/permissionAudits.test.tsx`:
  3 passed; renders the actual stream component and inspects its tooltip.
- All built tests corresponding to current `web/tests/*.test.ts` sources:
  1,930 passed. The first broad `dist/web/tests/*.test.js` invocation also
  included a stale generated `agentWorkspaceRoute.test.js` with no source;
  the final run enumerated current source files to exclude retired artifacts.
- `npm run build -w web`, `npm run lint -w web`, and
  `npm run lint:css -w web`: pass.
- `npm run test:react -w web`: 664 passed, 1 timed out in
  `rosterTabs.test.tsx` (composer keyboard selection, outside this change).
  Retrying with `npm run test:react -w web -- --maxWorkers=2` passed all
  665 tests across 111 files.
- `npm audit --audit-level=high --registry=https://registry.npmjs.org`:
  reports 12 existing dependency vulnerabilities (5 moderate, 6 high, 1 critical).
  The configured registry mirror does not implement the audit endpoint.
- `git diff origin/main --check`: passes.

## Scope and remaining limits

The implementation derives display-only approval data from the existing event
log. It changes no API, database, daemon, authorization, or credential contracts.
Existing transcripts are projected through the same path. No backend suite or
browser E2E suite was run for this frontend-only change.

Codex history whose ids were translated uses ordered target matching after an
exact-id search; repeated identical targets have only their order to distinguish
them. Approvals with no matching action remain visible inside the agent turn.

Checkpoint commits preserve the failing review regressions and the subsequent
passing fix separately. This report retains the RED/GREEN evidence if the PR is
squash merged.
