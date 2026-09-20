# Project-owned tasks

Status: Target design, with the Tasks navigation implemented. The secondary
project sidebar, mobile selector, project-required browser creation, and removal
of project Activities are implemented. Backend-wide required ownership, legacy
migration, and deferred computer setup remain planned; this document does not
claim those contracts are implemented.

## Decision

Every task belongs to exactly one project. Projects are the primary place to
organize work; All tasks is a view across accessible projects. Routine definitions
and their generated tasks follow the same ownership rule.

A project describes the ongoing context: what the work is for, which agents can
work on it, and where execution happens. A task describes a bounded outcome,
its acceptance criteria, priority, and progress. Runs are attempts to complete a
task; conversations and artifacts preserve the evidence of those attempts.

```text
Main navigation    Secondary navigation       Main content
Projects           Project list               Project details / agents / workspace
Tasks              All tasks                  Task list or selected task details
                   Website launch
                     Write release brief
                     Build launch page
                   Internal tools
                     Update onboarding
```

Project membership is mandatory. Agent assignment, a due date, and execution
setup are optional while planning. Project agents are executors, not a human
access-control list.

## What changes from today

The existing project page already opens on Tasks and creates tasks with a
`projectId`. However, `POST /tasks` accepts a missing project, the task table's
`project_id` is nullable, and global task creation has no required project
context. Projects currently require a registered computer at creation time.

This proposal changes those contracts. It supersedes ADR-017's optional task
membership and required computer at creation, if accepted. ADR-018's immutable
workspace bindings and historical workspace recovery remain authoritative.
Standalone conversations may remain outside projects; converting one to a task
requires choosing a project.

## Product experience

### Tasks navigation with a project sidebar

Projects and Tasks remain separate top-level destinations. Projects opens the
project list and project details, including agents, workspace, and settings.
Tasks opens a shared task surface with a secondary sidebar of tasks grouped by
project. Expand a project to reveal its tasks; select a task to read Activity,
Definition, and Files in the main pane while the sidebar stays visible.

The All tasks entry opens the cross-project list. Selecting a project heading
filters that list, and New task inherits the selected project. Creating from All
tasks requires choosing a project. On mobile, a project dropdown provides scope.

Project pages retain their task overview, but selecting a task navigates to Tasks.
`/projects` and `/projects/{id}` remain project destinations; `/backlog?project={id}`
is the scoped task list and `/backlog/{taskId}?project={id}` is the task detail.
Legacy project task drawer links redirect to the corresponding Tasks detail.

Keep the existing workflow: Backlog → Ready → Running → Review → Done. Ready
uses the existing `assigned` status. Blocked and waiting-for-human remain visible
exceptions, with the reason and next action shown on the task. Do not invent a
second task lifecycle for projects. Retain the employee-scoped work-in-progress
limit; changing project filters must not change that limit.

The project header offers New task. Secondary sections are Routines, Agents,
Files, and Settings. Activity and execution details live inside task records;
projects have no Activities tab. “Agents” replaces the ambiguous “Team” label for
the project roster. Existing tab URLs remain supported as aliases.

Show completed/total task counts as task completion, not a promise of project
completion. Exclude routine definitions from those counts and include actual
occurrences. Do not automatically archive a project when its current tasks finish.

### Task creation always has project context

| Entry point | Behavior |
| --- | --- |
| Inside a project | Project is fixed and visible; ask for title first. |
| All tasks or global shortcut | Require a project picker; preselect an explicit project filter when present. |
| No projects exist | Offer Create project, then return to the preserved task draft. |
| Conversation → task | Inherit its project, or require selection if it has none. |
| Duplicate task | Preserve its project by default; validate the destination before saving. |
| Routine occurrence | Inherit the routine's project; no independent project picker. |
| API, import, or automation | Supply and validate an explicit project ID. |

There is no “No project” choice and no silent default or catch-all Inbox project.
A user can create an ordinary General project for miscellaneous work. Switching
the selected project before saving revalidates the executor and shows any cleared
assignment; it must never silently submit an incompatible agent.

Project creation initially needs only a name; purpose is optional. Computer and
agent setup can follow. An unconfigured project supports planning and shows
“Set up execution” when the user tries to start work. An offline configured
computer shows an offline state, not a request to create another project.

### Task details and All tasks

Task details show a Project → Task breadcrumb and the required project identity.
Keep existing stable task URLs so bookmarks survive. From All tasks, opening and
closing a task preserves the originating filters and scroll position.

All tasks supports project, status, agent, priority, and due-date filters. Every
row/card names its project; grouping by project is available. It operates on the
same records as project boards. Archived projects are excluded by default and
available through an explicit filter.

Task details emphasize the goal, acceptance criteria, responsible agent, state,
and result. Runs and conversations remain supporting history. Files distinguish
shared project files from retained task/run artifacts.

## Domain rules

- A task and its project have the same owner. Project association grants no new
  employee access; existing task access rules still apply. Audit legacy assignee
  access separately rather than exposing project files through task membership.
- A task may use project-led execution or an enabled member of its project roster.
  Independent team assignment is not supported for new project tasks, consistent
  with today's project task API. Legacy team assignments need explicit conversion.
- A project can exist without a computer or agents. Starting tasks or enabling a
  routine requires valid execution setup. Once bound, its computer remains fixed;
  moving files or execution to another computer is a separate migration feature.
- New tasks inherit the project's workspace on first execution. Existing task
  bindings always win: assigning a project never moves files, rewrites paths, or
  replaces linked historical sessions. Shared workspace serialization remains.
- Ordinary project reassignment is permitted only before any run, workspace
  binding, or linked execution history exists, and never while dispatch is claimed.
  Validate ownership, roster, and destination readiness in an atomic operation.
  Otherwise create a new task in the destination and link the original as context.
- A routine can move only before its first occurrence and while disabled. Once it
  has occurrences, create a replacement routine in the destination instead.
- Archiving makes the project read-only and stops new admission and routine
  promotion. Already admitted runs may finish and record results; archival does
  not cancel them. History remains readable. Hard deletion must not orphan tasks.
  Disabled projects likewise prevent new work; display their reason explicitly.

## API and persistence

Retain `POST /tasks` and stable task IDs; require `projectId` at the boundary.
Missing IDs return `400 project_required`. Validate existence, ownership,
archival, and enabled state server-side. Runtime creation paths must share these
rules, including routine generation, imports, and any direct store callers.
Historical event replay must still understand old events without project IDs.

Extend `GET /tasks` with a project filter applied before ordering and pagination,
for both summary and full views. Preserve existing authorization and response
contracts. Project counts must come from the complete authorized scope, not the
currently loaded page. Include project scope in query keys and invalidate project
counts, All tasks, and task details after relevant mutations.

The final task projection uses a non-null `project_id` with the existing restrictive
foreign key. Membership additions and changes are authoritative task events,
recorded with actor and migration provenance; snapshots and relational columns
are derived in the same transaction. Replay must reproduce the final membership.
Never backfill only the SQL column or edit historical creation events.

Deferred project execution setup needs event-backed computer binding, nullable
unbound computer storage, and fail-closed dispatch/workspace validation. Existing
bound projects retain their settings. An unconfigured project must never result
in a daemon command or a guessed filesystem path.

## Existing data and rollout

1. Inventory every task without a valid project, including completed/deleted
   tasks, routine definitions, and occurrences. Produce a dry-run report grouped
   by owner and recorded computer, including conflicting/missing history and team
   assignments. Do not infer projects from directory names.
2. Deploy compatible readers, event replay support, deferred project setup, and
   project-aware creation in all clients. Audit every producer before strict
   enforcement so shortcuts and scheduled work cannot bypass the rule.
3. Prepare explicit task-to-project mappings. Existing valid memberships stay.
   Offer bulk creation of ordinary named projects per owner/computer for legacy
   work, but require deliberate mappings rather than silently grouping it all.
   Unknown owners or conflicting routine families require resolution.
4. Quiesce affected dispatch and routine promotion, wait for admitted runs to
   settle, and apply mappings idempotently through task events. Previously bound
   tasks keep their exact bindings, even when different from the project's shared
   directory. Reject computer mismatches. Unrecoverable workspace history remains
   non-runnable and visible with its reason; membership does not repair it.
5. Convert legacy team assignments explicitly to supported project execution,
   recording changes without rewriting prior manifests. Revalidate access and
   executor placement. Routine families must have consistent project membership.
6. Enforce required IDs on all writers, verify zero unmapped rows and replay/
   projection agreement, then apply the non-null constraint. Lock or otherwise
   fence writers during the final validation/constraint transition. If unresolved
   mappings remain, stop the cutover with a report; do not claim migration complete.

The transition may temporarily read legacy unassigned records. The final product
has no unassigned-task category. Schema rollback can relax the constraint but
must retain assignment events and project records; restoring old code after new
membership/binding events requires a compatible replay reader.

## Implementation and verification

Primary surfaces are `backend/relay/api/task_routes.py`, project catalog/helpers,
project and task stores, scheduler/dispatch/workspace services, Alembic migrations,
shared TypeScript task contracts/replay, web forms/creation intents, task views,
and API documentation. Audit chat and import producers rather than assuming the
browser is the only writer.

Acceptance checks:

- Every creation entry point requires a valid accessible project; cross-owner,
  missing, archived, and disabled projects cannot accept new tasks.
- Project creation and task planning work without a computer; execution fails
  clearly until configured. Ordinary configured-project execution still works.
- Routine creation/promotion preserves membership and respects archival, including
  races with archive, dispatch claims, and project reassignment.
- All tasks and project views agree on records and actions; project filtering,
  counts, pagination, cache refresh, and stable detail navigation remain correct.
- Tasks has one secondary project sidebar, with All tasks, expandable project task groups, and New project;
  selecting a project scopes both the view and creation. Mobile selection,
  existing project links, reload, and browser Back preserve project context.
- Migration is restartable and preserves event replay, files, bindings, task IDs,
  history, and access. Cover completed/deleted tasks, missing owners, conflicting
  computers, legacy team assignment, and routine families.
- New inserts cannot bypass the required project through a direct store call.
  Database schema and metadata agree after migration.

Run focused API/store/scheduler and UI interaction tests, migration/schema-drift
checks, TypeScript compilation, web build, and the repository test suites during
implementation. The navigation implementation is tracked in `testing/project-task-navigation.tdd.md`.
