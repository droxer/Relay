# Frontend fifth-review fixes

Journeys were derived from the fifth frontend review. Existing changes were
preserved; no checkpoint commits were created.

## Guarantees

- All opening requests carry a stable idempotency key for same-draft retries,
  including text-only sends. The operation key distinguishes routing targets.
- Queued text stays in sessionStorage until acknowledgement. Retries forward
  the persisted queue id through the composer as the user message id. A queue
  recovered after reload waits for the person to send it.
- Notification mutations keep optimistic counts and reconcile from the server
  after the last pending operation. Guarded failure rollback preserves newer
  edits instead of restoring an obsolete whole-inbox snapshot.

## Evidence

- RED: both new cases in `web/interaction-tests/fifthReviewFixes.test.tsx`
  failed before implementation (missing opening key; missing pending queue).
- RED: the delayed-read-receipt case in `notificationHooks.test.tsx` failed
  against the original hook: unread count 1 instead of 0 after settlement.
- GREEN: delivery, queue, notification, isolation and stop checks: 43 tests.
  After hardening rollback, focused notification/queue/regression checks:
  19 tests passed.
- TypeScript web check and targeted lint passed.
- Built message-routing, queue and notification checks: 48 tests passed.
- Impeccable source detector over the composer: no findings.

## Limits

Opening-send retry identity is retained in memory for the current draft.
Queued messages additionally retain their identity in sessionStorage. Recovery
never guesses whether an interrupted request was accepted; retries use the
same queue message id for backend deduplication. Tests control API outcomes;
production network latency was not measured.

## Final verification

- Full React coverage run: 951 tests in 161 files passed; configured coverage
  thresholds passed (96.16% statements, 87.59% branches, 94.73% functions,
  98.62% lines). Those percentages cover the repository's configured five
  recovery/navigation modules, not all changed files.
- Final production build and TypeScript checks passed.
- Browser performance and agent-resume suites: all 15 tests passed.
- Targeted lint and `git diff --check` passed.
