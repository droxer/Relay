# Project task list and execution drawer

## Intent and scope

Tasks uses the same second sidebar and section layout as Routines. The sidebar
lists All tasks and every exact task status, with counts scoped by the project
and other filters. All tasks and selected statuses both show one flat, sorted
list, without repeating status group headings. Project filtering remains in the
filter bar. Rows name their project,
due date, and assignee; execution controls stay in the drawer.

Opening a record retains scope, filters, sort, pagination, and list position.
The board remains available with its saved view preference. API contracts,
authorization, persistence, and daemon dispatch are unchanged.

## Evidence

User journeys were derived from the request; no separate plan was supplied.
The initial three interaction tests failed against the previous implementation:
there were no project groups or desktop project filter, and a record replaced
the list and inferred its project scope. The final thirteen interaction tests pass
after moving status grouping entirely into the Routines-style second sidebar,
including preserved project-loading error feedback and sorting across statuses.

| Guarantee | Verification | Result |
| --- | --- | --- |
| Default list stays flat with status filtering only in the second sidebar | `tasksWorkspace.test.tsx` | Passed |
| Opening and closing execution retains the all-project list | `tasksWorkspace.test.tsx` | Passed |
| Project filtering remains available with no matches and preserves search | `tasksWorkspace.test.tsx` | Passed |
| Bulk selection includes only rows on the current list page | `tasksWorkspace.test.tsx` | Passed |
| Simple rows omit metadata/actions and use the shared status navigation | `tasksWorkspace.test.tsx` | Passed |
| Status navigation preserves project scope and independent counts | `tasksWorkspace.test.tsx` | Passed |
| Blocked tasks stay separate from their underlying workflow stage | `tasksWorkspace.test.tsx` | Passed |
| Clearing filters keeps the selected status | `tasksWorkspace.test.tsx` | Passed |
| Project directory failures remain visible with retry | `tasksWorkspace.test.tsx` | Passed |
| Explicit saved board preference survives | `tasksWorkspace.test.tsx` | Passed |
| Real popup filters, drawer tabs, close, search persistence, and direct links work | `tasksWorkspace.spec.ts`, desktop and mobile | 2 passed |
| Mobile task titles are not covered by sticky group headings | Browser hit test in `tasksWorkspace.spec.ts` | Passed |
| Frontend source contracts and import hygiene | Focused Node regression tests | 15 passed |
| Production build and TypeScript checking | `npm run build -w web` | Passed |
| Changed stylesheet and whitespace | `npx stylelint web/src/styles/backlog-list.css web/src/styles/tasks-workspace.css web/src/styles/list-sort.css`, `git diff --check` | Passed |

Full Python suite: 1,753 passed (536 warnings).
Full TypeScript suite: 1,684 passed. Full React suite: 35 files, 204 tests passed. The final focused suite covers
13 task-list, filter, and navigation scenarios.
The two existing source assertions for board-first rendering and shared lane
pagination were updated to assert the new list-first behavior and separate
list/board pagination.

Visual checks covered 1440×900 and 390×844 layouts. The mobile check caught a
stale sticky-header offset and render containment on stacked rows; the header
now uses zero offset when its column headings are hidden and task rows size to
content. Screenshots were inspected after drawer animation completion.

Interaction tests substitute a native project select to isolate filter and URL
behavior from portal/focus behavior. Browser tests use the real popup and drawer.
Coverage percentage was not measured. Browser data is intercepted in tests only;
no runtime/server data was seeded.

Project, Priority, and Due stay visible in a compact filter row. More filters
reveals agent, team, assignment, assignee, and source controls and remembers its
collapse state. The due filter includes a seven-calendar-day window starting today.
URL tests cover the new parameters on list and detail routes. Unit tests verify
agent/team/legacy assignment detection and due-window boundaries. Browser tests
exercise the actual Assignment and Team popups, filtered rows, and Clear.
