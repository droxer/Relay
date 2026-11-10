# Frontend latency fixes: test evidence

Journeys were derived from the frontend review: open an older thread by URL,
recover its updates without SSE, visit unrelated screens without downloading
transcripts, and reconcile tasks without repeatedly parsing unchanged JSON.

| Guarantee | Test | Evidence |
| --- | --- | --- |
| A routed thread outside the first list page never displays another conversation | `web/interaction-tests/frontendLatency.test.tsx` | Selection regression failed before the fix and passed afterward |
| A live older thread reconciles without a summary change signal or SSE | `web/interaction-tests/frontendLatency.test.tsx` | Recovery regression failed before the fix and passed afterward |
| Settled threads reconcile slowly enough to detect reopening, and connected streams avoid fallback fetches | `web/interaction-tests/frontendLatency.test.tsx` | PASS |
| Missing threads expose a retry, and access failures do not retry automatically | `web/interaction-tests/frontendLatency.test.tsx` | PASS |
| A 304 reuses parsed task rows; changed responses replace them; errors and aborted requests do not poison the cache | `web/interaction-tests/taskListTransport.test.tsx` | The 304 regression failed before the fix; all four transport tests pass afterward |
| Task reconciliation slows on unrelated screens and refreshes immediately when returning | `web/interaction-tests/relayDataRefresh.test.tsx` | PASS |
| Cross-origin web clients can read task ETags | `backend/tests/unit/test_deploy_config.py` | 43 tests passed |

## Focused verification

- Initial RED command: `npm run test:react -w web -- interaction-tests/frontendLatency.test.tsx interaction-tests/taskListTransport.test.tsx`.
  Three failures reproduced wrong-thread selection, stale disconnected details,
  and unsupported 304 reuse.
- GREEN command: `npm run test:react -w web -- interaction-tests/frontendLatency.test.tsx interaction-tests/taskListTransport.test.tsx interaction-tests/relayDataRefresh.test.tsx`.
  All 13 tests passed.
- The configured coverage set, exercised with the recovery, navigation, boundary,
  and lifecycle interaction tests: 100 tests passed; 96.16% statements,
  87.59% branches, 94.73% functions, 98.62% lines. The detail-recovery hook
  reached 100% lines and 82.5% branches. This is the configured five-file
  coverage set, not whole-frontend coverage.
- Final `npm run test:react -w web`: 157 files, 926 tests passed.
- Canonical `node --test dist/web/tests/*.test.js`: 2,080 tests passed.
- Combined core, supervisor, and frontend `node --test`: 2,397 tests passed.
- Full `npm run test:py`: 3,842 passed, 66 skipped, nine sandbox failures.
  The three installer failures were denied `/dev/tty` access; six MCP transport
  cases were denied their local servers. Rerunning
  `backend/tests/api/test_computer_installer.py` and
  `backend/tests/api/test_relay_mcp_transport.py` with those fixture permissions
  yielded 24 and seven passing tests respectively. All nine failures therefore
  have passing rerun results; 3,851 distinct backend tests passed across the
  full run and reruns.
- Changed-source ESLint, changed-Python Ruff, and backend mypy passed
  (458 Python source files).

## Browser regressions and limits

`web/e2e/performance.spec.ts` adds browser checks for an outside-page deep link,
zero transcript preloads on Settings, and a missing-link retry with the
composer disabled. The latter exposed two additional problems during
verification: onboarding hid the failure, and the composer could still submit
while the requested thread was missing. Both paths are now gated by the
explicitly requested thread.

The complete Playwright recovery suite was run against the production
Webpack export: 207 tests passed, including all three new browser regressions
and the existing performance budgets. One unchanged test,
`taskStatus.spec.ts:work in review docks a revision-bound review on the composer`,
still expects a `Ready for your review` heading and `.task-review-lede` that
the unchanged `TaskReviewPanel.tsx` does not render. Its isolated rerun failed
the same way. Those files were verified unchanged against HEAD.

The broad Node invocation also exposed two independently reproducible
model-discovery failures in unchanged daemon files. Its daemon outage run
did not settle and was stopped; the core/supervisor/frontend run above passed.

The review's task-transfer finding was overstated: existing backend ETag
middleware already avoids transferring unchanged bodies. The fix extends
that optimization to parsed-object reuse and reduces unrelated-screen polling
from every 10 seconds to every minute. The complete list contract remains;
changed responses still contain the full task summary collection and the
backend still constructs it before computing its ETag. This change makes no
claim to have paginated or bounded that backend work.

The default Turbopack build was attempted through `npm test` and
`make test-e2e`; its CSS worker failed to bind a local port with EPERM in the
execution environment. `npm run build -w web -- --webpack` successfully
compiled, type-checked, and exported the final frontend. No bundler settings
were changed in the repository.

`git diff --check` passed for this change's files. Concurrent daemon edits
were left untouched. The original Turbopack build cache was restored after
the build diagnostics.
