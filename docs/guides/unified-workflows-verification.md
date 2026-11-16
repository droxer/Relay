# Unified Workflow verification

Source plan: [Unified Team Workflows](unified-workflows.plan.md).

## Implementation

The predefined catalog and Team defaults use one Workflow ID contract.
Task/Automation selection and new conversation entry resolve that contract
before choosing the existing role-based or custom-step execution strategy.
The Team, Task, and composer selectors share one UI component and catalog.
Legacy style aliases and historical snapshots remain supported.

## RED/GREEN evidence

- `test_workflow_selection.py` initially could not import the missing selection
  module. Its three initial cases passed after adding the catalog, default
  resolver, and validated Team persistence. Commits `075131c7` and `966ea25e`
  preserve the test and implementation stages.
- `test_unified_workflows.py` reproduced missing catalog/default projections,
  custom inheritance, predefined assignment refusal, and missing frozen
  predefined Workflow IDs. The initial API tests and dispatch implementation
  are preserved by commits `2fc197a5` and `37942d19`.
- Direct predefined starts first failed with `workflow_not_found`; custom
  conversation starts first failed with `workflow_requires_project_runtime`.
  Both now use the selected strategy through the common selection interface.
- Legacy workflow-Team adoption first failed because top-level steps remained
  on the roster. Explicit default selection now atomically retains them as a
  child definition and enables normal predefined execution.
- The UI helper tests first failed to import the missing Workflow selector
  module. The final interaction tests select both predefined and custom IDs
  through one rendered picker. No separate collaboration setting remains on
  Team, Task, or composer surfaces.

## Guarantees

| Guarantee | Tests |
| --- | --- |
| Catalog, precedence, invalid IDs and legacy aliases | `backend/tests/unit/test_workflow_selection.py` |
| Team defaults, explicit overrides and frozen Run selections | `backend/tests/api/test_unified_workflows.py` |
| Manual, scheduled, and Automation entry share selection | Same API file |
| Both strategies can start through Workflow endpoints | Same API file |
| New Team conversations can use a custom default, with one persisted opening turn | Same API file |
| Owner-only custom authority and refusal of unsupported overrides | Same API file |
| Default definitions cannot be disabled or deleted | Same API file |
| Legacy Team adoption retains steps and identity | Same API file |
| Predefined role filling, dynamic Lead-led planning, review/repair, and approval policies | Existing Team, collaboration-style, and workflow regression suites |
| One picker emits canonical IDs and scopes custom choices | `web/interaction-tests/unifiedWorkflowSelection.test.tsx` |

## Validation

- Full Python backend suite: **4,755 passed, 34 skipped** with local socket and
  controlling-terminal permissions. Later default-adoption refinements passed
  the focused definition/selection/legacy API and store target: **62 passed**.
- Full built TypeScript suite: **3,313 passed**.
- Focused React interaction rerun: **47 passed**. The full React interaction
  suite passed all **1,292 tests** across 198 files. The final production static
  export passed with `npm run build -w web -- --webpack`.
- Ruff passed; mypy reported zero errors in 493 backend source files. Web and
  package TypeScript checks passed. `git diff --check` passed.
- New selection and conversation-entry modules: **96% combined statement
  coverage** (core selection 100%, entry adapter 93%), measured using the new
  unit and API tests with a temporary coverage.py installation. This is scoped
  coverage, not a repository-wide coverage claim.

The full backend and TypeScript suites were run using the configured shared
Python interpreter and locally installed npm workspaces. Coverage was measured
with `coverage run --source=relay.core.workflow_selection,relay.api.agents.workflow_entry`
against the new selection unit tests and unified workflow API tests.
No dependency, schema, credential, or production database change was needed.

The final Team settings picker was visually inspected with browser-only
fixtures at 1440×1000 and 390×844. It showed all three predefined processes
and both custom definitions together, with readable controls and no horizontal
overflow. Local screenshots are under `output/playwright/unified-workflows-*.png`.
Selecting the custom "Build a feature" option and saving the Team also
updated the read-only default summary to the saved custom steps in the mocked
browser flow.
