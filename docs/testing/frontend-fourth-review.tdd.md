# Frontend fourth-review fixes

The journeys come from the fourth frontend review. Existing working-tree
changes were preserved; no checkpoint commits were created.

| Guarantee | Test cases in `web/interaction-tests/fourthReviewFixes.test.tsx` | RED | GREEN |
| --- | --- | --- | --- |
| Queue acceptance clears a draft; capacity rejection keeps it and explains why | Empty and full queue | Full queue silently cleared the draft | Both acceptance and rejection pass |
| Panel revisions survive remounts without refetching unchanged data | Matching and changed revisions | Changed revision displayed cached empty result | Changed revision refreshes; matching revision reuses cache |
| Cookie-authenticated 401 responses trigger an auth probe | JSON, task-list revalidation, artifact text | All three left the shell authenticated | All three transition to anonymous after the confirming probe |
| Bearer-token rejection, 403, and cookie-free requests do not invalidate auth | Three negative cases | Already passed | Still pass |
| Concurrent failures and multiple auth consumers share one confirming probe | Two simultaneous API failures and two auth hook consumers | No probe ran | One probe runs; a confirmed valid session stays authenticated |

## Changes

- The queue store and hook return whether enqueue succeeded. The composer
  preserves rejected text and announces a capacity error in English and Chinese.
- Task revision history is held per QueryClient in a WeakMap. It survives a
  panel remount and remains isolated with each Account's personal cache.
  Revisions arriving during requests still wait for those requests to settle.
- All API-client fetch paths use `fetchWithSession`. Rejected cookie requests
  notify auth consumers; the shared auth query confirms expiry before the
  existing sign-out flow clears credentials. Bearer tokens, omitted cookies,
  aborted requests, and login/probe endpoints do not trigger this channel.

## Verification

- RED: the new regression file ran 11 cases: six failed for the intended bugs
  and five preservation cases passed.
- GREEN: the new file plus the previous two review regression files, thread
  queue tests, and auth session tests passed: 36 tests across five files.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- Targeted ESLint across nine changed production modules: passed.
- Impeccable source detector over the composer: no findings.
- `git diff --check`: passed.

## Final checks

- `npm run test:react:coverage -w web`: all 948 tests across 160 files passed.
  The configured coverage thresholds passed (96.16% statements, 87.59% branches,
  94.73% functions, 98.62% lines). The existing include list measures five
  recovery/navigation modules, not every file changed by this task.
- `npm run build -w web`: production export passed.
- `npx tsc -p packages/tsconfig.json`, followed by built API, response-shape,
  and thread-queue tests: all 60 tests passed.
- Browser performance suite: all 12 tests passed. Frontend recovery suite:
  all four tests passed, including the new expiry-to-sign-in flow. Its first
  run exposed that navigating from Threads to Tasks reuses the cached list;
  the test now explicitly refreshes to exercise a real rejected request.
- `git diff --check`: passed.

Browser tests mock backend responses; they verify client recovery and routing,
not production session configuration or network latency. No external service
state or credentials were changed.
