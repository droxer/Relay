# Frontend review fixes

The seven review findings are addressed by preserving prompt selection and form drafts, tying transcript observation to the mounted DOM, reconciling interrupted streams, making deletion rollback record-specific, and adding shared navigation protection and error boundaries.

The static-export SPA deployment stays supported. Navigation guards preserve Next's history state and add a traversal index. Back/Forward first restores the current entry, then replays the requested traversal only after confirmation. Agent profiles register one guard in the editor; the former parent and roster confirmations were removed to avoid asking twice.

Project member edits retain the version at which the draft began. A concurrent update produces the existing API conflict response while preserving the draft, rather than silently resetting it or overwriting the newer roster. The user can explicitly close and reopen to load the latest version.

SSE reconnects resume from the last committed event and use exponential backoff capped at 30 seconds. HTTP detail reads recover data during stream outages, and 401/403/404 responses stop reconnect attempts. Selection hydration retries failures and reconciles status changes so a completed summary cannot leave the final transcript missing.

Validation evidence:

| Finding | Regression evidence |
| --- | --- |
| Prompt selection | Mounted test failed before the stable callback; Chromium verifies full replacement typing with the actual Base UI input. |
| Stream recovery | Tests initially failed to recreate closed streams or recover completed output. Tests now cover reconnects, HTTP fallback, malformed/duplicate frames, terminal closure, revoked access, and stale-response cancellation. |
| Deletion rollback | A rejected deletion originally erased another thread's concurrent output. The test now preserves it and restores only the deleted thread. |
| Transcript observer | The original observer stayed attached after DOM removal. Tests now verify reattachment and respecting a reader who scrolls upward. |
| Member draft | Polling a newer project version originally reset the text. The mounted test now preserves it. |
| Navigation | Tests cover cancellation, accepted navigation, tab changes, and Back/Forward replay. Chromium covers sidebar cancellation, browser Back cancellation, and one-confirmation mobile Back. |
| Error boundary | The missing boundary was the initial failure. The mounted test verifies a visible fallback, retained navigation, and recovery on another route. |

The RED checkpoint is `7c873b93` (`test: reproduce frontend lifecycle and recovery failures`). Runtime failures were observed for the existing lifecycle and recovery paths; boundary/navigation tests initially failed because their new modules did not exist. The fix checkpoint carries the GREEN implementation and this report.

Commands:

- `npm test`: production builds, all TypeScript package/web tests, React interaction tests, and 1,123 backend tests passed before the final duplicate-guard cleanup. The final production build, all 1,358 TypeScript package/web tests, interaction suite, and Chromium suite were rerun after that cleanup.
- `npm run test:react:coverage -w web`: 15 tests; coverage thresholds of 80% pass for navigationGuard, ScreenErrorBoundary, useSessionDetail, useSessionEvents, and useTranscriptPin. Measured coverage: 95.45% statements, 86.4% branches, 96.07% functions, 98.88% lines. These are scoped module measurements, not whole-frontend coverage.
- `npm run test:e2e -w web`: builds the static export first, then runs three Chromium tests against a local static server with browser-intercepted API fixtures. Install Playwright Chromium or set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to an installed browser.
- `npx tsc -p packages/tsconfig.json` and the web production build verify TypeScript. The final web Node suite contains 1,050 passing tests; one obsolete source-pattern assertion was replaced by browser behavior coverage.

Browser validation used installed Chrome on macOS, not a live production backend. Firefox and WebKit were not exercised. The jsdom test dependency stays on version 26 to support the repository's Node 22.19 minimum. Dependency audit reports nine existing advisories (three moderate, six high); unrelated dependency upgrades are outside these fixes.
