# Project task threads

Journey derived from the request: opening a project task's conversation shows
it in Threads, with the project's existing badge in the thread list.

## Evidence

- RED: `npm run test:react -w web -- interaction-tests/taskThreadNavigation.test.tsx interaction-tests/taskThreadList.test.tsx`
  failed the new navigation test: expected `/threads/thread`, received
  `/backlog/task/threads/thread`. Checkpoint: `49a8c421`.
- GREEN: adding `interaction-tests/taskRecord.test.tsx` to the command passed
  all 15 tests. Checkpoint: `012c93b7`.
- Tests cover task-to-Threads navigation, sending and mobile Back, native result
  links and clicks, project badge names and fallback IDs, and existing nested
  deep links. Backend/API/data contracts are unchanged.
- `npm test`: production build succeeded; TypeScript tests: 1709 passed, 1 failed.
  The failure is `discoverAgentInventory scans live Kimi and Codex homes while
  ignoring legacy Kimi files`; it also fails in isolation, expecting
  `['kimi-live']` but receiving `undefined`. The test touches no changed files.
- `npm run test:react:coverage -w web`: 277 passed, 1 failed. The composer team
  Enter-key test in `rosterTabs.test.tsx` timed out after 60 seconds.
- Focused router coverage with the three test files and
  `--coverage --coverage.include=src/hooks/useAppRouter.ts` (thresholds disabled
  for measurement): 73.52% statements, 61.25% branches, 50% functions, 78.33%
  lines. This does not meet 80% for the entire router; unrelated navigation
  methods are not exercised by these focused tests.
- `npm run test:py`: all 1805 tests passed (581 warnings).
- `npx tsc --noEmit -p web/tsconfig.json` and `git diff --check`: passed.
- `npm audit --omit=dev --audit-level=high` could not run: the configured
  npmmirror registry returned 404 for its unsupported audit endpoint.

## Compatibility

Task result/history links now target `/threads/{id}`. Explicit task opens reveal
the list and preserve existing project indicators. Already-open nested task
links continue to support sending and returning to their task record.
No browser E2E run or manual visual review was performed.
