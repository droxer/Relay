# Composer image reset evidence

Source: the CI ESLint failure in `ComposerImages.tsx`; no external plan.

## User journey

When switching Threads, the composer must clear the previous Thread's image
draft before it commits, cancel its uploads, release preview URLs, and permit
uploads in the new Thread. Clearing or removing an image must remain usable.

## RED and GREEN

- RED checkpoint: `79198b32` adds the regression before the runtime change.
  `npm run test:react -w web -- interaction-tests/composerImages.test.tsx`
  ran five tests: four passed and the new test failed because a committed render
  for `thread-2` retained the image from `thread-1`.
- GREEN: the fix resets state conditionally during render when the draft key
  changes. The effect only cleans up upload resources; it does not set state.
  Generation checks still discard late responses, and cleanup releases the
  controller so the next Thread can upload.
- The same regression passes after the fix. The focused command below passes
  all 11 tests, including an additional preview-removal interaction test.

```sh
npm run test:react:coverage -w web -- \
  interaction-tests/composerImages.test.tsx \
  interaction-tests/composerOutdatedUploads.test.tsx \
  --coverage.include=src/components/composer/ComposerImages.tsx
```

| Guarantee | Test | Result |
| --- | --- | --- |
| A new Thread never commits the previous image draft | `never commits a previous Thread's images when switching drafts` | PASS |
| Late uploads cannot populate another Thread | `discards uploads that finish after switching Threads` | PASS |
| Failed sends keep images until explicitly cleared | `uploads once and retains image references for a failed send until explicitly cleared` | PASS |
| Failed uploads allow retry | `reports upload failure and allows retry` | PASS |
| Removing an attachment releases its preview | `removes an attached image and releases its preview URL` | PASS |

## Verification and limits

- Focused coverage of `ComposerImages.tsx`: statements 98.76%, branches 85.36%,
  functions 100%, lines 100%; all configured 80% thresholds pass.
- `npm run lint -w web`: zero errors, three existing warnings. The effect reset
  error and both ref cleanup warnings are gone.
- `npm run test:react -w web`: 794 tests passed after the runtime fix. The preview
  removal test added afterward also passed in the focused coverage run.
- The production web build passed as part of `make test-e2e`; browser results
  and repository-wide CI results are recorded in the PR.
- No Python runtime or protocol behavior changes. Python suite results from the
  CI setup remain partial locally; PostgreSQL coverage runs in CI.

The regression checkpoint and this fix commit preserve the RED/GREEN evidence
if the PR is later squash-merged.
