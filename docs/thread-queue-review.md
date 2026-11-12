# Thread message queue review

The original queue was a per-tab Zustand/sessionStorage collection. Only the
mounted thread view observed a run ending and sent the next entry. Switching
devices lost visibility; closing the tab or navigating away stopped advancement.

## Implemented changes

- Thread events now persist the queue, pause state, dispatch claim, and errors.
  Independent signed-in clients read the same state. Only the owner mutates it.
- The existing scheduler dispatches through collaboration admission after
  execution exit, independently of browsers. Stable admission IDs and durable
  enqueue receipts protect retries, including a lost response after dispatch.
- Per-thread database locking serializes claims and edits across replicas.
  Claimed messages cannot be removed or edited. A bounded rotating scan avoids
  starving later threads behind busy or blocked queues.
- Stop pauses the queue on the server. Steering chooses the next entry and
  requests cancellation with queue preservation. Human questions and permission
  waits hold automatic advancement. Failed admission keeps the message and
  exposes a paused state and error instead of discarding the text.
- Save acknowledgment precedes clearing the composer. Newer drafts and other
  threads' drafts survive late responses. Editing takes a message into the
  local composer only once; a second client receives a conflict.
- Legacy local messages transfer with their existing IDs, remain local until
  acknowledged, and import paused to avoid unexpectedly sending old text.
- The dock names saved, waiting, sending, and paused states, offers Resume,
  announces failures, and has 44px touch targets for row controls. Existing
  typography, palette, order, and keyboard controls remain in place.

## Verification boundaries

`backend/tests/api/test_thread_queue.py` exercises independent app instances,
persistence, receipts, paused imports, failed admission, claim exclusion, and a
real collaboration round delivered to the daemon registry with its mention
address preserved. No agent CLI or external computer is executed by these tests.

`web/interaction-tests/threadQueue.test.tsx` covers independent query clients,
save failures, Stop ordering, editing, and legacy migration. The TypeScript
projection test checks replay and duplicate-event handling.

`web/e2e/threadQueue.spec.ts` drives independent desktop and phone browser
contexts in both themes, checking synchronization, edits, recovery from a failed
save, draft retention, and horizontal containment. These browser checks use a
shared API fixture; the real server boundary is covered by the Python tests.

## Operational limits

Advancement follows the task scheduler interval (10 seconds by default) and
requires that scheduler to be enabled. Interrupted dispatch claims retry after
five minutes using the same admission key. Automatic work waits for a human
question to be answered; a failed admission requires Resume or a chosen message.
The queue remains text-only, with 20 entries of at most 100,000 characters each.
Editing intentionally returns text to a local composer draft. Queue reads poll
once per second while the thread is visible and refresh on window focus.

## Observed results

- Desktop/phone browser flows pass in light and dark themes, including Stop and
  Resume synchronization. Captured renders were inspected at 390px and 1440px.
- All 1,132 React interaction tests and 2,096 selected web/core tests pass.
- Eight queue API/integration regressions pass, including real round admission,
  interrupted-ack replay, ownership, and Stop racing with admission. Scheduler,
  route-auth, layering, module-size, and reducer-isolation checks also pass.
- Python mypy reports zero errors; Ruff and diff whitespace checks pass.
- The production export passes with `next build --webpack`. Turbopack fails
  in this environment because it cannot bind its helper port. Broad repository
  test runs were stopped after encountering sandbox restrictions, including
  installer tests denied access to `/dev/tty`; they are not claimed as passing.
