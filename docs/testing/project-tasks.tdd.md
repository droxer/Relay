# Project task workspace verification

Journeys were derived from the request to make projects organize tasks with status.

## Behavior

- Projects open on Tasks; Team, Workspace, and Activities remain available.
- The directory lists projects instead of expanding thread folders.
- Project task creation writes the existing `projectId` contract.
- Progress and workflow lanes exclude unrelated/deleted tasks and routine definitions,
  but include routine occurrences. Blocked and human-waiting statuses remain visible.
- Starting work invokes existing dispatch; accepting a reviewed result updates the
  authoritative task status. Archived and disabled project boards are read-only.
- Existing task records provide detailed editing, run history, and linked threads.

## RED / GREEN evidence

- `npm run test:react -w web -- projectTasks.test.tsx` initially failed to resolve
  the new ProjectTasks component, the implementation required by these journeys.
  After implementation: 5 tests passed.
- `node --test dist/web/tests/appRoute.test.js` reproduced removal of
  `?tab=profile` when Team became a secondary tab. Corrected the project URL
  vocabulary and default. Combined route/project tests: 33 passed.
- RED checkpoint: `4658f5d1`. Initial checkpoint attempts were rejected by the
  typecheck hook because relay-core had not been built and because the new
  creation input type was not yet staged. The successful checkpoint includes
  that type declaration. No hooks were bypassed.

## Verification

| Guarantee | Command | Result |
| --- | --- | --- |
| Project scoping, progress, create/retry, read-only and lifecycle actions | `npm run test:react -w web -- projectTasks.test.tsx --coverage --coverage.include=src/components/ProjectTasks.tsx` | 5 passed; statements 92.85%, branches 89.65%, functions 94.11%, lines 100% |
| URL defaults and existing project rules | `node --test dist/web/tests/appRoute.test.js dist/web/tests/projectPage.test.js` | 33 passed |
| Existing package/web unit contracts | `node --test dist/packages/relay-core/tests/*.test.js dist/packages/relay-chat/tests/*.test.js dist/packages/relay-daemon/tests/*.test.js dist/packages/relay-supervisor/tests/*.test.js dist/web/tests/*.test.js` | 1,653 passed before the additional routing regression; routing regression verified separately |
| React interaction regression suite | `npm run test:react -w web` | 30 files, 169 tests passed |
| Desktop/mobile creation, progress, scrolling and Team navigation | `RELAY_E2E_PORT=58763 npx playwright test -c playwright.recovery.config.ts projectTasks.spec.ts --workers=1` (in web) | 2 passed |
| Backend regression suite | `npm run test:py` | 1,753 passed (536 deprecation warnings) |
| Production compilation | `npm run build -w web` | Passed |
| CSS token rules | `npm run lint:css -w web` | Passed |
| Production dependency audit | `npm audit --omit=dev --registry=https://registry.npmjs.org --audit-level=critical` | 0 vulnerabilities |

The initial `npm test` runs caught weight/tracking token violations, which were
fixed and verified against the complete Node suite and focused typography tests.
The configured npm mirror has no audit endpoint; the audit above used the public
registry without changing configuration.

## Limits

Browser tests intercept API responses; they do not execute real agents. Existing
backend project tests cover project task creation and daemon dispatch. No schema,
backend state machine, authorization, or execution-plane behavior changed.
