# Frontend second-review fixes

Journeys were derived from the second frontend review in this session. Existing
working-tree changes were preserved; no checkpoint commits were created.

| Guarantee | Regression test | RED | GREEN |
| --- | --- | --- | --- |
| A failed optimistic edit preserves a newer successful edit on the same task or another task | `web/interaction-tests/secondReviewFixes.test.tsx` (two cases) | Successful priority reverted to `normal` | Successful priority retained; an untouched failed row rolls back |
| Empty and settled automation ledgers discover newly scheduled runs | Same file (two cases) | No new run after 30.5 seconds | Newly scheduled run appears |
| A mounted artifact panel refreshes on a parent task revision | Same file | New deliverable absent | New deliverable visible without remounting |
| A growing live fence has bounded highlighting work and receives highlighting when settled | Same file | 2,568,590 characters highlighted, exceeding the 100,000-character budget | 16,821 characters highlighted for the same 400-line input |

## Implementation

- Rollback restores only the affected task and only if its optimistic row is
  still the cached row. Newer edits and server responses take precedence;
  existing settlement invalidation reconciles skipped rollbacks.
- Settled run ledgers poll every 30 seconds for new occurrences. Ledgers with
  unfinished runs retain their 10-second cadence. Background polling remains
  disabled by the existing query defaults.
- Artifact panels invalidate both version views when the parent task's status
  or update timestamp changes, retaining the selected file and preview.
- Live fences longer than 1,024 characters render through React text nodes.
  Settled fences still use the existing full syntax highlighter.

## Verification

- RED: `npm run test:react -w web -- interaction-tests/secondReviewFixes.test.tsx`
  executed six regression cases; all failed for the reported behaviors.
- GREEN: the regression file and existing task-creation, artifact, routine-run,
  and streaming-Markdown files passed: 20 tests across five files.
- `npm run test:react -w web`: 932 tests passed across 158 files.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- `npm run build -w web`: production export passed.
- `npx tsc -p packages/tsconfig.json` followed by
  `node --test dist/web/tests/syntax.test.js dist/web/tests/relayPolling.test.js`:
  29 tests passed.
- Targeted ESLint over the seven changed production files: passed.
- From `web/`, `npx playwright test -c playwright.recovery.config.ts performance.spec.ts --workers=2`:
  12 browser performance tests passed, including desktop and mobile streaming.
- Impeccable source detector over changed components: no findings.
- `git diff --check`: passed.

## Measurement limits

The highlighting metric counts input characters passed to `hljs.highlight`
while appending 400 lines. It measures parser work, not browser frame time or
network latency. Browser tests use mocked API responses. The new regression
cases exercise real query caches and components with controlled API outcomes.

## Coverage

`npm run test:react:coverage -w web` passed all 932 tests and the configured
80% thresholds: statements 96.16%, branches 87.59%, functions 94.73%, and lines
98.62%. The repository's coverage configuration includes five existing recovery
and navigation modules; these percentages do not represent coverage of every
changed file. The six new regression cases independently cover the four fixes.
