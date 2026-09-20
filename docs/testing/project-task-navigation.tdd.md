# Tasks navigation and project ownership in browser forms

Journeys come from the agreed project sidebar design and the request to remove
project Activities so execution details live in tasks.

## Delivered behavior

- Tasks is the primary destination; projects appear in its secondary sidebar.
  All projects opens the combined task board. Mobile uses a project selector.
- Existing project URLs select the project inside Tasks. Legacy Activities URLs
  return to Tasks; task Activity, Definition, and Files remain available.
- Browser task and routine forms require an enabled, unarchived project. Project
  task creation inherits its project. Executor options respect project membership.
- Global New task from a project's secondary section returns to its Tasks tab.
- Creating a project from a task draft preserves the draft and selects the new
  project. Routine creation supports the same project setup drawer.
- English, Simplified Chinese, and Traditional Chinese labels are updated.

## RED / GREEN evidence

`npm run test:react -w web -- taskProjectNavigation.test.tsx` initially failed
because `ProjectTaskNav` did not exist. The assertions guard against restoring
the separate Projects destination or the Activities tab. The focused navigation
tests now pass.

Browser testing reproduced a shortcut that retained the Agents tab because
same-path navigation preserved query parameters. Explicit navigation to the
project's Tasks URL fixes it. Deferring title focus until the panel is visible
fixes the mobile focus case.

RED checkpoint commits were attempted twice, but repository hooks rejected them:
first because relay-core had not been built, then because stashing the implementation
left new untracked components referencing old tracked prop contracts. No hooks
were bypassed. The failed-command evidence is recorded here instead of claiming a
successful RED commit.

## Verification

| Guarantee | Command | Result |
| --- | --- | --- |
| Navigation, mobile selector, archive visibility, errors, creation validation | `npm run test:react -w web -- taskProjectNavigation.test.tsx taskProjectCreation.test.tsx --coverage --coverage.include=src/components/ProjectTaskNav.tsx` | 10 passed; new navigation component: 100% statements/lines/functions, 91.66% branches |
| Task creation, project board, and task record tabs | `npm run test:react -w web -- taskProjectCreation.test.tsx taskProjectNavigation.test.tsx projectTasks.test.tsx projectRecordTabs.test.tsx` | 19 passed |
| Full repository suites and production build | `npm test` | 1,680 Node tests, 185 React tests, 1,753 Python tests passed; 536 backend warnings |
| React regression after routine project setup changes | `npm run test:react -w web` | 33 files, 185 tests passed |
| TypeScript | `npx tsc --noEmit -p web/tsconfig.json` and `npx tsc -p packages/tsconfig.json` | Passed |
| Final production web build | `npm run build -w web` | Passed |
| CSS tokens | `npm run lint:css -w web` | Passed |
| Production dependencies | `npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=critical` | 0 vulnerabilities |

Browser verification uses `RELAY_E2E_PORT=58764 npx playwright test -c
playwright.recovery.config.ts projectTasks.spec.ts --workers=1` from `web/`.
All 3 browser tests passed. They cover desktop/mobile navigation, project creation, task details, required
project selection, and preserved task drafts. Browser tests use intercepted API
responses and do not execute agents.

## Scope and limits

This is the browser navigation and creation portion of the design. The backend
optional-project contract, legacy tasks, and persisted workspace bindings are
unchanged. Backend enforcement, event-backed legacy assignment, non-null schema
migration, and project creation before computer setup remain planned in
`../project-task-ownership-design.md`. No production data or external resources
were changed. Project and cross-project boards retain their existing layouts.
