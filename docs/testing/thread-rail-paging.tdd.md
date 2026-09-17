# Thread rail paging regression

The journey comes from the frontend review: open thread 350 in a 400-thread
directory, then scroll to the end of the mounted rail to reach older threads.

The selected thread extended the mounted window to 360 rows while the page
counter remained at one. Advancing that counter to two did not change the
window or remount its intersection sentinel. Paging now advances from the
effective mounted page count.

## Red and green evidence

- Red checkpoint: `e438b183`. From `web/`, run
  `npx playwright test -c playwright.recovery.config.ts performance.spec.ts --grep 'selected thread deep'`.
  The regression expected 400 rows after scrolling and received 360.
- Green checkpoint: `0ff58a80`. From `web/`, run
  `npx playwright test -c playwright.recovery.config.ts --workers=2`.
  All 15 tests passed, including the same deep-link regression, ordinary rail
  paging, idle rendering, transcript paging, lazy bundles, and layout checks.
- `npm test`: production builds, 1,525 TypeScript tests, 80 React tests,
  and all 1,557 backend tests passed (four backend warnings).
- `npm audit --registry=https://registry.npmjs.org --json`: zero vulnerabilities.

The browser test covers the real observer and production bundle. No numeric
coverage measurement was collected for this callback. This fix preserves
incremental mounting; it does not introduce a fixed-size virtualized list.
