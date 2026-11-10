# Frontend third-review fixes

Journeys came from the third frontend review. Existing working-tree changes
were preserved; no checkpoint commits were created.

| Guarantee | Regression cases | RED | GREEN |
| --- | --- | --- | --- |
| A list revision arriving during a detail request causes a follow-up read, even if the list row was initially absent | Two cases in `web/interaction-tests/thirdReviewFixes.test.tsx` | Only the old request ran | Two reads; the latest title is retained and settled polling stops |
| A mounted Activity history fetches final events on completion | Same file | One read; no completion refresh | A second read follows the completion revision |
| A mounted result summary displays the final run result | Same file | Final failure text absent | Final failure text visible without remounting |
| Snapshot recovery batches missing events and preserves inputs and projections | Same file | Batch reducer never called | One batch call, no individual replay, original inputs unchanged |

## Implementation

`useTaskQueryRevision` defers consuming revision changes until the current
request settles. Task details and the Activity panels share it; the existing
artifact revision refresh also uses it to retain changes during pending reads.
The parent record supplies its status and update timestamp to all three panels.

Snapshot reconciliation accepts the existing batch reducer. Detail hydration,
SSE recovery, and mutation responses all supply it. The callback-free merge
also appends its missing events once; the individual callback remains available
for compatibility with custom reducers.

## Verification

- RED: `npm run test:react -w web -- interaction-tests/thirdReviewFixes.test.tsx`:
  all five regression cases failed for the intended behavior.
- GREEN: that file plus `taskRecordPolling.test.tsx`, `secondReviewFixes.test.tsx`,
  and `recordHistory.test.tsx`: 16 tests across four files passed.
- `npx tsc -p web/tsconfig.json --noEmit`: passed.
- Targeted ESLint across changed production modules: passed.
- Impeccable source detector across changed task-record components: no findings.
- `git diff --check`: passed.

## Performance evidence

For a snapshot with 20,000 events trailing the live cache by 2,000 events, the
old individual replay copied 42,001,000 event-array entries. The batched path
copies 22,000 entries in one reducer call and preserves all 22,000 events. This
is an operation-count measurement from a synthetic local probe, not a claim
about production browser frame time or network latency.

## Final checks

- `npm run test:react:coverage -w web`: 937 tests across 159 files passed.
  Configured coverage thresholds passed: statements 96.16%, branches 87.59%,
  functions 94.73%, lines 98.62%. The existing coverage include list covers
  five recovery/navigation modules, not every changed file.
- `npm run build -w web`: production export passed.
- `npx tsc -p packages/tsconfig.json` and built session poll/event/stream tests:
  34 tests passed.
- Browser performance suite: all 12 tests passed. Task status suite: all six
  tests passed after updating an outdated assertion for the existing compact
  review panel. The updated test still verifies visible acceptance controls,
  expanded evidence, and the revision-bound acceptance request.
- The task-status rerun required allowing its local test server to bind
  localhost after the sandbox rejected the bind; the rerun passed.
