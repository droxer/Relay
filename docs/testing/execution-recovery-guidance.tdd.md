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
- English, Simplified Chinese, and Traditional Chinese strings share the same
  recovery keys. Mobile notices have their own grid row, leaving the transcript
  flexible and scrollable.

## Ownership and invariants

The change is confined to web presentation, tests, and documentation. Backend
recovery semantics, authorization, event stores, ownership reservations, and
unblock behavior are unchanged. No schema migration or new dependency is needed.
Unknown reasons receive an operator-facing fallback. This does not add force
termination, force deletion, automatic reruns, or an operator reconciliation API.

## TDD evidence

- `78c5fab9`: initial RED checkpoint. The new interaction test referenced the
  missing recovery guide and panel; Vitest failed import resolution for that
  implementation, before production code was added.
- `57a613d0`: implementation checkpoint after focused GREEN validation.
- `91f1352a`: runtime RED regression for workspace contention on an in-progress
  task (expected `ownership`, received `undefined`).
- `5b32fd36`: GREEN correction and the visually verified mobile grid fix.

| Guarantee | Validation | Result |
| --- | --- | --- |
| All execution reasons, dispatch categories, unknown codes, stale outcomes, retry feedback, duplicate-request disabling, legacy host identity, navigation guard, and blocking-thread links | `npm run test:react:coverage -w web -- interaction-tests/executionRecovery.test.tsx --coverage.include=src/lib/executionRecovery.ts --coverage.include=src/components/ExecutionRecoveryPanel.tsx` | 34 passed; statements 98.41%, branches 96.42%, functions 100%, lines 100% |
| Mobile retry calls only the recovery endpoint; unconfirmed termination offers computer navigation; task drawer explains unblocking; board still uses the real execution flow | From `web/`: `npx playwright test -c playwright.recovery.config.ts executionRecovery.spec.ts taskKanban.spec.ts` | 4 passed |
| Existing repository behavior | `npm test` | 1,553 TypeScript tests, 112 React tests, 1,692 Python tests passed |
| Production compilation and export | `npm run build -w web` | Passed |
| CSS and diff hygiene | `npm run lint:css -w web -- --quiet`; `git diff --check` | Passed |
| Dependency audit | `npm audit --registry=https://registry.npmjs.org` | 0 vulnerabilities |

The full repository run preceded the final workspace-contention regression and
layout correction. Focused coverage, web typecheck, and browser checks were rerun
for those changes. Production build and mobile screenshots verified the layout;
the final workspace-contention rule was verified by the focused runtime test.

## Practical limits

Browser tests intercept API responses and verify client behavior; they do not
simulate real daemon crashes or database outages. The full Python suite exercises
existing backend behavior. Recovery still requires the execution host or an
administrator when exit evidence is missing. The default npm mirror does not
implement the audit endpoint; the successful audit used the official registry
without changing local configuration.
