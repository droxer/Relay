# Task thread context

Journeys were derived from the request to keep project task conversations with
the task and remove project-wide conversation entry points.

- Opening a task's thread keeps Tasks selected and supplies a task breadcrumb.
- Sending in that thread retains its task URL.
- Reload, native links, and mobile Back preserve task ownership.
- Legacy project thread URLs resolve to their linked task; project-wide creation
  URLs open the project's task list. Existing persisted conversations are retained.

## Evidence

`npm run test:react -w web -- taskThreadNavigation.test.tsx` first failed both
routing tests: the nested task thread route was not recognized and its session
was not selected. The same tests passed after implementation; a third test checks
the task breadcrumb and removal of the project activity link.

The RED checkpoint commit was attempted, but the pre-commit web typecheck failed
because relay-core had not yet been built. Hooks were not bypassed. Building
relay-core resolved that prerequisite.

- Full initial `npm test`: production build, 1,688 Node tests and 243 React tests
  passed; 1,787 Python tests passed with 570 warnings in 315.04 seconds.
- After native task-link changes: 243 React tests and 1,252 web Node tests passed.
- Production web build includes TypeScript validation.
- Desktop/mobile browser tests exercise legacy redirects, task selection,
  reload, return to task, opening a task thread, and retired project creation.
- Production dependency audit: zero vulnerabilities.

Browser command: from `web`, `RELAY_E2E_PORT=58766 npx playwright test -c
playwright.recovery.config.ts projectTasks.spec.ts --grep 'task thread stays'
--workers=1`. API responses are intercepted; no agents are executed.

Coverage limits: these are focused route, interaction, and browser regressions,
not a claim of 80% coverage across the application. Backend conversation storage
and APIs remain compatible; this change removes the project-wide browser flow.

Final desktop and 390px mobile browser checks passed (2 tests). Screenshots were
inspected; the mobile task back action is in the topbar and the context band stays
compact. TypeScript, CSS lint, and `git diff --check` passed. No data migration or
remote action is required.

## Threads directory and project badges

Follow-up requirement: task conversations also belong in the Threads page/list,
with their project visible as a badge. Opening from Threads retains `/threads/s`;
opening from Tasks retains `/backlog/t/threads/s`. Both share the same session.

`npm run test:react -w web -- taskThreadList.test.tsx` initially failed because
project task threads were filtered out and sending from Threads changed the URL
to Projects. RED checkpoint: `70fceac9`. The four final tests cover listing,
project badges, project-name search/rename, loading fallback, independent threads,
and sending/mobile Back in Threads. Together with task navigation tests, 7 pass.

Desktop and 390px mobile browser journeys pass (2 tests), including task-context
navigation, Threads listing, accessible project labels, clicking through,
reload, and mobile return to the list. Screenshots were inspected on both sizes.
The production build/typecheck, CSS lint, and diff check pass. Full frontend
suites pass: 1,688 Node tests and 276 React tests.
