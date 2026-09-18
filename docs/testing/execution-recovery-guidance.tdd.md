# Execution recovery guidance

Users can now read the cause and next step in the affected thread or task drawer.
This work was derived from the request to make recovery-required execution and
other blockers actionable; there was no external plan file.

## User journeys and behavior

- A thread that cannot save its terminal result explains the failure and offers
  **Retry saving results**. The button requests bounded finalization recovery,
  disables during the request, reports errors, and distinguishes an accepted
  request from completed recovery. Changing threads or reasons resets feedback.
- Unconfirmed termination, unreachable computers, orphaned records, dispatch
  waits, stopping, and result-saving each have specific guidance. Relevant states
  link to Computers. Pending deletion explains why cleanup must wait.
- Task and routine drawers preserve the recorded failure and explain assignment,
  access, computer readiness, provisioning, workspace, capacity, WIP, ownership,
  exhausted retries, runtime failure, human input, and review blockers. Navigation
  links open the relevant surface or the actual blocking thread when recorded.
- Task guidance explains the existing board Unblock action: it restores the prior
  stage rather than directly executing an agent. Previously running work returns
  to waiting for human input. Runtime errors without structured cause codes retain
  their actual reason and receive inspection guidance, not an inferred diagnosis.
- Healthy running and completed work is quiet. Workspace contention remains
  visible for in-progress tasks. Old dispatch outcomes cannot override human waits,
  review, completion, or a subsequently started execution.
- The notice warns only about faults. Work that is simply waiting on a person —
  a result in review, a question awaiting an answer — carries an informational
  rail instead, so the amber edge keeps meaning something.
- An execution whose computer will never report exit can be reported gone. The
  action appears only where the evidence Relay waits for can no longer arrive
  (`termination_unconfirmed`, `orphaned_run`, `execution_unconfirmed`, and an
  unknown reason) — never where a retry still repairs a saved result, and never
  while Relay can still expect a daemon to answer. It confirms first, in the
  shared danger dialog, because it is an assertion rather than an observation
  and cannot be undone.
- Every way out of the notice is the shared link-button control, so it reaches
  the touch target on a coarse pointer and matches the wayfinding anchors on the
  surfaces around it. A surface that already links a thread passes it as
  `excludeSessionId`, so one drawer never offers the same thread twice; a
  different blocking thread still gets its link.
- English, Simplified Chinese, and Traditional Chinese strings share the same
  recovery keys. Mobile notices have their own grid row, leaving the transcript
  flexible and scrollable.

## Ownership and invariants

`POST /threads/{id}/execution/reconcile` is the one path that releases an
execution without daemon exit evidence. It is confined to an execution already
in `recovery_required`, so it can never force-stop live work; it is authorized
like every other thread route (the owner or an administrator, never a daemon
node token); and it writes `session.execution_reconciled` with its actor, so the
log never reads as though the computer reported the exit. It then closes the
retained command, the run request, and any running agent projection through the
same seams deletion uses, which lets a pending deletion drain on the next tick.

The recovery notice is the one surface that links a blocked task's thread. The
task drawer's workspace section still explains why its listing is stale and
names the blocking thread, but does not link it. Unknown reasons receive an operator-facing
fallback. No schema migration or new dependency is needed, and task dispatch,
unblock behavior, and the event stores are otherwise unchanged. This still does
not add force termination of a live agent, automatic reruns, or any path that
deletes a thread while Relay believes its agent is running.

## TDD evidence

- `78c5fab9`: initial RED checkpoint. The new interaction test referenced the
  missing recovery guide and panel; Vitest failed import resolution for that
  implementation, before production code was added.
- `57a613d0`: implementation checkpoint after focused GREEN validation.
- `91f1352a`: runtime RED regression for workspace contention on an in-progress
  task (expected `ownership`, received `undefined`).
- `5b32fd36`: GREEN correction and the visually verified mobile grid fix.
- Reconcile pass (this commit): the guidance pointed at Computers, but nothing
  there could resolve it. `canDelete` requires a terminal phase, the only
  existing release path needs a daemon terminal claim (so it covers
  `finalization_failed` alone), and deleting the node is refused while its stuck
  request counts as active work. A probe confirmed all four blocked reasons
  survive stop-and-delete plus repeated scheduler ticks. Eight backend tests
  were written first and failed with 404 on the missing route.
- UI review pass: tone, the link-button contract, the duplicated
  thread links, the dead `thread.retry_recovery` / `thread.recovery_failed` keys,
  and a live region that was mounted at the same moment as its text. Written as
  corrections to reviewed code rather than from a RED checkpoint; each carries a
  test that fails against the reviewed behavior, including a coarse-pointer
  browser measurement of the action against `--touch-target`.

| Guarantee | Validation | Result |
| --- | --- | --- |
| All execution reasons, dispatch categories, unknown codes, stale outcomes, retry feedback, duplicate-request disabling, legacy host identity, navigation guard, blocking-thread links, rail tone, link-button grammar, the pre-mounted live region, and thread-link de-duplication | `npm run test:react:coverage -w web -- interaction-tests/executionRecovery.test.tsx --coverage.include=src/lib/executionRecovery.ts --coverage.include=src/components/ExecutionRecoveryPanel.tsx` | 39 passed; statements, branches, functions, and lines 100% |
| Mobile retry calls only the recovery endpoint; the gone report asks first and calls reconcile only after confirmation; unconfirmed termination offers computer navigation; the action meets the touch target under a finger; task drawer explains unblocking; board still uses the real execution flow | From `web/`: `npx playwright test -c playwright.recovery.config.ts executionRecovery.spec.ts taskKanban.spec.ts` | 5 passed |
| Reconcile releases a stuck execution, frees an orphaned run, records its actor, refuses live and terminal executions, is idempotent, and rejects a node token or a non-owner | `pytest backend/tests/api/test_execution_reconcile.py` | 8 passed |
| The report is offered only where evidence cannot arrive, confirms before asserting, and reports failure | `npm run test:react -w web -- interaction-tests/executionRecovery.test.tsx` | 50 passed |
| Existing repository behavior | `npm test`; `pytest` | 1,553 TypeScript tests, 132 React tests, 1,700 Python tests passed |
| Production compilation and export | `npm run build -w web` | Passed |
| CSS and diff hygiene | `npm run lint:css -w web -- --quiet`; `git diff --check` | Passed |
| Dependency audit | `npm audit --registry=https://registry.npmjs.org` | 0 vulnerabilities |

Every row above was rerun against the reviewed code, so the table no longer
describes an earlier state of the branch. Production build and mobile
screenshots verified the layout; the workspace-contention rule was verified by
the focused runtime test, and the touch-target guarantee by a browser
measurement rather than by reading the stylesheet.

## Practical limits

Browser tests intercept API responses and verify client behavior; they do not
simulate real daemon crashes or database outages. Reporting an agent gone is an
assertion about a machine Relay cannot see: it releases Relay's reservation and
nothing more, so a process that is in fact still running keeps running, unowned.
That is why the action is confined to executions Relay has already given up on,
names its actor in the log, and asks for confirmation that says so. The full Python suite exercises
existing backend behavior. Recovery still requires the execution host or an
administrator when exit evidence is missing. The default npm mirror does not
implement the audit endpoint; the successful audit used the official registry
without changing local configuration.
