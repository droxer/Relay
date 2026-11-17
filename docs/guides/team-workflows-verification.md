# Workflows: verification

The user journeys for this refactor were derived from the request to separate
the Team roster from its reusable processes:

1. Create two Workflows under one Team without replacing its roster or policy.
2. Edit or delete one definition without affecting its siblings or frozen runs.
3. Select a Workflow independently on a Project Task or Automation.
4. Keep owner-only approval gates, retries, and live membership admission.
5. Read existing workflow Teams and historical runs without rewriting them.

## TDD evidence

The first API reproducer ran before implementation and failed because
`POST /teams/{id}/workflows` returned 404. The Task reproducer subsequently
failed because the created Task had no `assignedWorkflowId`. Both passed after
implementation. Intermediate checkpoint commits were not created; this report
preserves the RED/GREEN evidence for the final refactor commit.

| Guarantee | Evidence |
| --- | --- |
| Independent definitions, roster preservation, owner authority, malformed writes, immutable Project, independent run identity and frozen snapshots | `backend/tests/api/test_team_workflow_definitions.py` |
| Task selection, switching, clearing, wrong-Team and standalone refusal | Same API test file |
| Deleted definitions preserve frozen runs; disabled/deleted Teams and removed participants cannot authorize commands | Same API test file |
| Definition validation, legacy read adapter, detached snapshots, durable events, name uniqueness and failed-write isolation | `backend/tests/unit/test_workflow_definitions.py` |
| Editor sends only definition fields and deletes only the selected Workflow | `web/interaction-tests/teamWorkflowDefinitions.test.tsx` |
| Workflow form dirty checks and assignment clearing | Same interaction file and `web/tests/taskBoardForm.test.ts` |

## Checks executed

- Full backend suite: 4,652 passed, 73 skipped; 4 failures and 23 setup errors
  were local socket or controlling-terminal sandbox denials. Rerunning the five
  affected integration files with local permissions passed all 54 tests.
- Final new API target: 12 passed. New pure/store target: 12 passed.
- Full built TypeScript suite: 3,312 passed, zero failures.
- Full React interaction suite: 1,256 passed; the subsequently expanded
  Workflow interaction target passed its five tests.
- `ruff check backend`: passed. Backend mypy: zero errors in 490 source files.
- Web type check and package TypeScript compilation: passed.
- Production static web export: passed with `npm run build -w web -- --webpack`.
  The default Turbopack build could not bind its CSS worker's local port in
  this environment, including on retry with local permissions.
- `git diff --check`: passed. Production npm audit using the official registry:
  zero vulnerabilities. The configured mirror does not implement npm audit.

Coverage was measured with a temporary installation of coverage.py, without
changing project dependencies:

```sh
PYTHONPATH=backend:/tmp/relay-workflow-coverage COVERAGE_FILE=/tmp/relay-workflow.coverage \
  /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m coverage run \
  --source=relay.core.workflows,relay.api.agents.workflows -m pytest \
  -c backend/pyproject.toml -n0 backend/tests/api/test_team_workflow_definitions.py \
  backend/tests/unit/test_workflow_definitions.py
```

The new definition modules measured 92% combined statement coverage: core
100%, API 86%. This is scoped coverage, not a claim of repository-wide coverage.
No production database or third-party resources were changed.

The production export was inspected in an isolated browser with client-only
fixtures at 1440×1000 and 390×844. The Workflow list showed two definitions
under one Team; the editor preserved readable fields and reachable footer
actions at both sizes. Screenshots are local ignored artifacts under
`output/playwright/team-workflow-editor-{desktop,phone}.png`.

After rebasing onto main's scheduling, owner-question, and styling changes,
143 focused backend checks passed across definition management, scheduled
Tasks and Automations, workflow decisions/progression, Task workflows, and
workflow event/result policies. The focused React interaction rerun passed
14 tests. The new scheduler tests first failed because an explicit Workflow
selection fell through to ordinary Team dispatch, then passed after updating
scheduler routing to recognize `assignedWorkflowId`.

## Team ownership and Project use — 2026-11-17

Regression tests first reproduced five UI gaps: incompatible inherited defaults
remained selectable, the Team library lacked default controls, failed Project
reads became setup advice, changing Project silently reassigned steps, and
Projects retained a definition editor. A second reproducer showed the Task
picker excluding a larger Team even when a custom Workflow used only Project
Agents. These tests passed after the UI changes; no checkpoint commits were
created for this pass.

- `npm run test:react -w web`: all 199 files and 1,309 tests passed.
- Final PR check added a reproducer for inline assignment offering a larger
  Team with an incompatible default. Inline assignment now requires that
  default to fit; drawers can offer other compatible Workflows. The focused
  ownership, Task creation and Automation drawer targets passed all 56 tests
  after this guard; app type checking passed again.
- `web/e2e/teamWorkflows.spec.ts`: all 12 browser tests passed against local
  Next.js, with mocked APIs. Coverage includes desktop/phone defaults, custom
  creation, Project run entry, legacy definitions, Task overrides, and a custom
  Workflow using a subset of the Team roster. API-shaped legacy projections
  were additionally rerun in both viewports.
- Workflow selection helper coverage: 100% lines, 96.96% statements, 90.19%
  branches, 100% functions (`workflowOwnership.test.tsx`, Vitest V8).
- Built workflow draft, Task assignment and run-projection targets: 20 tests
  passed using `node --test`.
- App type checking and package/test TypeScript compilation passed.
- Scoped ESLint: zero errors, one existing unused-variable warning in
  `TeamWorkspacePage.tsx`. Workflow CSS Stylelint passed.
- Impeccable source scan over workflow components, Team profile and Task drawer:
  zero findings. Desktop/phone screenshots inspected; no horizontal overflow
  in the checked journeys.
- `npm audit`: one existing moderate Next.js advisory, GHSA-mfr8-8qww-v76h;
  dependencies were not changed by this pass.

This pass changed UI and documentation only. It did not rerun the backend suite
or production export, and browser API fixtures do not certify real daemon execution.

PR #843 CI follow-up: `paletteTokens.test.ts` caught a duplicate focus-ring
declaration on the new step disclosure. Removing the local rule preserves the
shared `summary:focus-visible` styling in `tokens/base.css`. The existing focus
contract reproduced the failure before removal; afterward all 2,177 built web
tests and Workflow CSS Stylelint passed.


## Independent Project Workflows — 2026-11-17

This refactor replaces Team ownership with independent Project definitions and
optional Team assignment. The accepted model is ADR-025. Tests first reproduced
the missing canonical API, standalone dispatch/approval refusal, and legacy Team
edits not reaching the extracted record. These paths now use one definition
store; no synthetic Team is created for standalone execution.

Regression coverage includes zero-Team creation/run, multiple Team links,
unassignment and Team deletion preserving definitions, per-Project defaults,
a stale read not overwriting another Project's default, Task/Automation scheduler
starts, owner-only management, live Project membership, legacy editing/conversion,
and idempotent migration preserving definition IDs/steps/timestamps.

- Backend suite: **4,809 passed, 34 skipped**. Local loopback, terminal and
  PostgreSQL migration tests ran with their required access. Initial failures
  exposed a missing local daemon build, a legacy snapshot-envelope mismatch,
  and an overly broad downgrade guard; all were corrected and rerun.
- Migration/real-daemon targets: **38 passed**, including an independent four-step
  process through failure, retry, gated approval, backend restart and frozen
  definition preservation. The deterministic Agent Runtime substitutes model
  output; the backend, daemon, HTTP transport and stores are real.
- After incorporating the merged scheduler/Team-thread fixes, unified and
  independent Workflow API targets: **38 passed**.
- React suite: **200 files, 1,314 tests passed**. Built web Node tests:
  **2,177 passed**, including palette, typography, route and projection contracts.
- Browser suite: **15 passed**. Journeys cover Project management, Team assignment/defaults, legacy
  definitions, zero-Team direct starts in desktop/phone layouts, and a saved
  standalone Workflow Task. API fixtures advance update timestamps to exercise
  record refresh; they do not stand in for the real-daemon tests above.
- Production static export, app/package TypeScript compilation, backend mypy
  (503 files), Ruff, CSS lint and diff checks passed. ESLint has zero errors and
  three existing warnings outside the changed workflow components.
- Impeccable source scan: zero findings. Inspected desktop/phone Project lists
  and the phone run drawer; the new tab shares Project gutters and has no
  horizontal overflow in the tested journeys.
- After incorporating the merged Next.js security update, the production
  dependency audit reports **zero vulnerabilities**. No dependencies are added
  by this refactor.

Rollout requires migration 0129 before serving this version. An empty database
can downgrade; once Workflow records exist, downgrade refuses rather than losing
Project-only definitions. Existing run snapshots and execution reservations are
preserved. Use a forward fix after rollout.

## Team and Project ownership scopes — 2026-11-17

ADR-026 revises Project-only authoring: Team creation requires no Project and
persists `ownerTeamId`; Project creation retains `projectId`. Migration 0130
checks that exactly one owner is present. Existing Project definitions retain
their ownership, including those created through legacy Team routes.

Scope regression tests cover Team creation without a Project, reuse in two
Projects, global Team defaults, Automation assignment, explicit Project selection
on direct starts, refusal by another Team, and Project definitions usable by an
eligible Team without a link. Run snapshots bind the selected execution Project
without modifying the reusable Team definition.

- Backend suite: **4,814 passed, 34 skipped**, including PostgreSQL migrations
  and real daemon execution. Targeted ownership API tests passed again after
  adding the direct-start assertion.
- React: **1,315 passed** across 200 files. Built web tests: **2,177 passed**.
- Browser suite: **17 passed**, including zero-Project Team creation on desktop
  and phone. Captures wait for the editor's closing animation to finish.
- Production export, TypeScript compilation, mypy, Ruff, ESLint and design scan
  passed (ESLint retains three existing warnings). No dependencies changed.

A Project is still selected for execution, as requested. Team-owned workflows
require their owning Team and compatible Project participants. Project-owned
workflows remain available to that Project's Tasks and Automations; assigning
or using one never transfers its ownership. Migration 0130 refuses downgrade
while Team-owned definitions exist.
