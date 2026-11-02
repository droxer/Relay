# Task review validation

The review flow lets a person inspect delivered work, distinguish claims from
verification, request
changes through the existing Thread, and accepts the recorded revision.

## Contract and implementation

The brief is derived from persisted Task and Thread snapshots. It introduces
no generated summary, migration, execution path, or automatic verification.
The newest Task-scoped manifest selects participating assignments. The latest
attempt supplies each report; recorded artifacts keep their exact versions.
Missing criteria, reports, artifacts, or verification remain explicit.

The same panel appears on a Task in Review and on its current linked Thread.
An open brief does not poll or refresh on focus/reconnect. A refused stale
acceptance disables Accept until the person explicitly refreshes successfully.
The decision is not optimistically marked complete before the server commits.

## TDD evidence

- Before implementation, the six API tests failed: the review endpoint returned
  404 and PATCH ignored the missing conditional-acceptance contract.
- Unit tests initially failed to import the new review module.
- Interaction tests initially failed to resolve the new review panel.
- Additional regression tests reproduced a review changing under the person
  when another surface refreshed shared query data, and an artifact read
  falling back to mutable workspace bytes. Both now pass: reads are scoped
  to each mounted review, and output links request snapshots only.
- RED/GREEN evidence is recorded here rather than in separate checkpoint
  commits. The implementation is committed together for the pull request.

| Guarantee | Target |
|---|---|
| Claims stay distinct from CLI execution facts | `backend/tests/unit/test_task_review.py` |
| Other rounds are excluded; the latest repair supplies the report | Same unit target |
| Changed requirements, round, evidence, or artifact invalidate the revision | Unit and API targets |
| Anonymous and unrelated users cannot read/accept the review | `backend/tests/api/test_task_review_api.py` |
| A successful conditional acceptance records the displayed revision | Same API target |
| Stale acceptance never marks the Task done | API and interaction targets |
| Missing records and failed reads remain actionable | `web/interaction-tests/taskReview.test.tsx` |
| Desktop/mobile rendering and refresh-before-accept work in the browser | `web/e2e/taskStatus.spec.ts` |

## Verification results

- Focused backend tests: 17 passed across `test_task_review.py` and
  `test_task_review_api.py`.
  Cover attributed reports, latest repairs, missing data, authorization,
  stale/duplicate acceptance, exact snapshot bytes and snapshot-unavailable
  refusal. Python's standard-library line tracer measures the new review
  module at 97.8% (88/90 executable lines); the trace harness lives at
  `/tmp/relay-review-line-coverage.py`.
- Review interaction tests: 9 passed. V8 coverage for `TaskReviewPanel.tsx`:
  94.11% statements, 97.89% branches, 100% functions, 100% lines.
- Final affected browser tests: 12 passed across `taskStatus.spec.ts` and
  `taskKanban.spec.ts`, including light desktop and dark mobile captures.
- Production builds: webpack and the default Turbopack export both succeeded.
  TypeScript compilation, backend mypy, backend Ruff, changed-file ESLint,
  typography-token tests, and diff whitespace checks passed.
- Broad backend run: 724 tests passed before continuing the remaining collected
  tests across four processes. The shards reported 2,649 passed, 10 skipped,
  and one failure. `test_app_factory_requires_database_for_thread_storage`
  cannot assert absent configuration because the existing local backend env
  file supplies a database. The analogous
  `test_bootstrap_without_an_admin_token_is_unavailable` failed in the initial
  run for the same local-configuration reason and was deselected in the resumed
  run. Local configuration files were not changed.
- `npm test`: production build and TypeScript compilation succeeded; the Node
  suites reported 2,901 passed and two failures in the untouched daemon
  `agent-models.test.ts` (Codex model list and cached Claude model list).
- Full React run exposed a roster keyboard-test timeout. The file passed all
  four tests when retried alone; a subsequent run excluding that file passed
  747 tests. A review-cache regression found during development was fixed and
  its focused regression test passes.
- `make test-e2e`: the full initial run passed 105 tests and failed three. The
  Task board fixture was updated from legacy Done to revision-bound Accept,
  and all 12 affected browser tests subsequently passed. The other two failures
  are in untouched agent-filter and team-responsibility surfaces: a missing
  Add filter button and an unexpected `role: implementer` in the saved form.

The broader repository suites are therefore not reported as clean. Their
logs are retained under `/tmp/relay-review-*`; no unrelated fixes are included.

Before the PR commit, `npm audit --registry=https://registry.npmjs.org --json`
reported 34 findings: 1 critical, 7 high, 25 moderate, and 1 low. No dependency
or lockfile changes are included. The configured npm mirror lacks an audit
endpoint, so the official registry was queried without changing local config.

## Observed-user validation protocol

This is a follow-up study requiring actual participants; automated tests do
not establish its outcomes. Use five people with real tasks and record the
same measures before and after enabling this review surface.

1. Ask the person to delegate a task with a clear deliverable and criterion.
2. Once it reaches Review, time their inspection without coaching.
3. Ask what was delivered, what was checked, and what remains uncertain.
4. Have them request one change and inspect the subsequent result.
5. Have them accept the final recorded result.

Record decision time, transcript openings, whether claims were mistaken for
verification, missing information, and rework found after acceptance. Record
the Task and round ids alongside observations. Do not add synthetic outcomes
or inferred time savings to the product.

## Limits

The protocol currently contains agent-reported evidence rather than trusted
per-check execution records. Existing clients that omit `reviewRevision` retain
their legacy PATCH behavior. File edits outside Relay do not update stored
Artifact snapshots. The UI states both evidence and workspace limits directly.
