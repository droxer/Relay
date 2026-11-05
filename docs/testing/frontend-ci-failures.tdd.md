# Frontend test failure evidence

Source: the failed frontend checks in PR #658 and the request to fix them;
no external plan.

## User journeys and diagnosis

A signed-in Account must keep its thread selection when notifications mount.
Its authentication state is shared across the app, while its personal data
cache remains separate. Retrying a recovery must reuse its operation ID.
Agent search and member-contract edits must survive reload.

The personal-data provider introduced a nested QueryClient. Notification hooks
called `useAuthSession` against that empty client, issued another `/auth/me`, and
treated the result as a new sign-in. Clearing global selection left loaded
threads invisible. Authentication now explicitly uses the outer auth client;
the existing per-Account personal cache remains separate.

Four assertions also described older code: counting every idempotency key as a
recovery key, requiring an unbraced hydration condition, expecting the retired
agent availability-chip UI, and omitting the member role persisted by the editor.
The tests now check the current contracts, including real recovery retries and
agent search persistence after reload.

The full React run also exposed a roster-selector timeout. A CPU profile found
recursive `Element.matches` → NWSAPI `isFullscreen` → `Element.matches` calls
while Floating UI checked top-layer state. The test environment now supplies
false for the modal/fullscreen states jsdom does not implement. The fallback is
installed per test and restored with the other mocks. The roster test waits for
the actual focus change rather than sleeping inside `act`, and uses the normal
test timeout. Its focused run passes all four tests in 581 ms instead of
occasionally timing out after 60 seconds. Production selector behavior is intact.

## RED and GREEN

- RED checkpoint `e5c35df0`: `personalSpaceAuth.test.tsx` fails because mounting
  the nested consumer unexpectedly calls `/auth/me`.
- The existing Node targets reproduce two failures: 38 passed, two failed.
  After updating their scope/format expectations: 40 passed, zero failed.
- The offered-answer browser test independently reproduces disappearing
  thread state. After the auth fix, the browser suite improves from 64 passing /
  60 failing to 122 passing / two failing. The final two failures are the stale
  agent-filter and member-role expectations; their six-test focused run passes
  after updating the contracts.
- Auth and recovery interaction targets pass all 18 tests.

```sh
npm run test:react -w web -- \
  interaction-tests/personalSpaceAuth.test.tsx \
  interaction-tests/authSession.test.tsx \
  interaction-tests/threadStop.test.tsx
node --test dist/web/tests/messageBlock.test.js dist/web/tests/taskBoardReviewFixes.test.js
cd web && npx --no-install playwright test -c playwright.recovery.config.ts \
  filterChips.spec.ts teamCollaboration.spec.ts --workers=2
```

| Guarantee | Test | Result |
| --- | --- | --- |
| Nested auth consumers retain selection and use the auth client for updates | `personalSpaceAuth.test.tsx` | PASS |
| Personal caches do not inherit private data from the auth client | `personalSpaceAuth.test.tsx` | PASS |
| Rerun and handoff retries reuse their operation ID until success | `threadStop.test.tsx` parameterized recovery test | PASS |
| Recovery requests have a single idempotency-key dispatch path | `messageBlock.test.ts` | PASS |
| The initial view stays deterministic and restores storage after mount | `taskBoardReviewFixes.test.ts` | PASS |
| Agent quick search filters real roster rows and survives reload | `filterChips.spec.ts` | PASS |
| A saved responsibility retains its member role through later edits | `teamCollaboration.spec.ts` | PASS |

## Coverage and verification

Focused V8 coverage of `useAuthSession.ts` and `PersonalSpaceProvider.tsx`:
95.16% statements, 86.36% branches, 93.33% functions, and 98.11% lines.
The 80% thresholds pass. The full built frontend Node suite passes 2,013 tests.
Final complete frontend checks pass:

- `node --test dist/web/tests/*.test.js`: 2,013 passed.
- `npm run test:react -w web`: 798 passed across 137 files.
- `cd web && npx --no-install playwright test -c playwright.recovery.config.ts`:
  124 passed, including the real browser recovery and popup flows.
- `uv run --project backend --locked --extra dev pre-commit run --all-files`:
  all 17 hooks passed.
- `npm audit --registry=https://registry.npmjs.org --audit-level=low`:
  zero vulnerabilities.

The production web build passes. No Python runtime, HTTP contract, credential
format, or database changes are involved. Temporary instrumentation was removed.
The RED checkpoint and the fix commit containing this report preserve evidence
for a later squash merge.
