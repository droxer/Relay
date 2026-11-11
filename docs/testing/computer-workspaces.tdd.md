# Computer and Project workspaces

Journeys derived from the user's review and request to fix all four findings:
standalone Threads, Tasks, and Automations stay in their Computer workspace;
Project work stays in its Project workspace, including creation, records,
runs, conversation links, and return navigation.

## Implementation

Computer routes use stable Computer identities. Task creation events save the
selected Computer; updates may place legacy work but cannot move an existing
workspace. Assignments and dispatch remain on that Computer. Automation
occurrences inherit their Automation's identity. These additions use existing
event and snapshot storage; no database migration is required.

The client scopes lists and creation controls, restores Project conversation
navigation, and redirects legacy or mismatched record URLs into their owning
workspace. Legacy unplaced work has an explicit placement action inside a
Computer workspace. Execution directories remain isolated as documented in
CONTEXT.md; this change does not merge them into a shared directory.

## RED and GREEN evidence

- `node --experimental-strip-types --test web/tests/workspaceScope.test.ts`
  initially failed both cases: Computer routes lost their identity and the
  standalone rail included Project Task and manager conversations. The final
  four tests pass, including Automation occurrence and record-link cases.
- The first two tests in `backend/tests/unit/test_computer_work_scope.py`
  failed because Computer-scoped Tasks were still intake and creation events
  discarded their Computer. Policy, event replay, dispatch filtering, and
  Automation inheritance tests now pass.
- `computerWorkspace.test.tsx` reproduced a return link crossing Computer
  workspaces and an assignment picker offering Agents on another Computer.
  Both now pass. The full React run also caught a partial Project record
  widening assignment choices; that regression was corrected.

| Guarantee | Tests |
| --- | --- |
| Computer URLs retain scope, records, runs, and owned query state | workspaceScope.test.ts |
| Project conversations never appear in the standalone rail | workspaceScope.test.ts, taskThreadList.test.tsx |
| Legacy and mismatched links resolve to their owning workspace | workspaceRouting.test.tsx |
| A Project can start and retain its own conversation | workspaceRouting.test.tsx, taskThreadNavigation.test.tsx |
| New standalone Tasks save the selected Computer | computerWorkspace.test.tsx, test_issue_triage.py |
| Legacy placement is explicit, authorized, and immutable | computerWorkspace.test.tsx, test_issue_triage.py |
| Computer scope survives replay and Automation promotion | test_computer_work_scope.py |
| Assignment and dispatch cannot cross the saved Computer | computerWorkspace.test.tsx, test_issue_triage.py, test_computer_work_scope.py |

## Validation

- `npx tsc -p packages/tsconfig.json`: passed.
- `node --test dist/web/tests/*.test.js`: 2,099 passed.
- Package Node suite: 1,060 passed. The adapter tests require local sockets;
  the successful run used `node --test --test-timeout=120000` outside the sandbox.
- `npm run test:react -w web -- --reporter=dot`: 1,018 passed in 167 files.
- `npm run test:py`: 3,923 passed, 66 skipped, and nine sandbox failures.
  All nine passed outside the sandbox: the installer file passed all 24 cases,
  and the MCP transport file passed all seven cases. The failures were access
  to `/dev/tty` or binding local HTTP/IPC servers, not workspace assertions.
- `npm run build -w web -- --webpack`: passed, including static export.
  Turbopack could not bind its local CSS worker port in this environment.
- Backend mypy: zero errors in 459 source files. Ruff and changed frontend
  source ESLint checks passed. `git diff --check` passed.
- Scope-helper coverage: 100% lines/functions, 92.45% branches. Routing-hook
  coverage: 100% lines/functions, 87.36% branches. Repository-wide coverage
  was not measured.
- Disposable Playwright browser checks used mocked API responses at desktop
  1440×900 and phone 390×844. They verified Computer Task/Thread isolation,
  Computer Automation navigation, Project conversation creation, and legacy
  Project Task/Thread redirects. No page errors or horizontal overflow were
  observed; desktop and phone screenshots were visually checked.

Changes remain uncommitted. RED/GREEN evidence is preserved here rather than
in separate checkpoint commits.

## Local daemon and Agent Runtime enforcement

Follow-up scope: enforce the boundary beneath the UI, prioritizing local
Computers and installed agent CLIs.

- The control plane places authoritative Computer, Project, Task, and
  Automation identities on `run.start`. The daemon checks these before
  acquiring or creating a workspace or spawning an Agent Runtime. A backend
  that provides a Computer identity cannot downgrade a command by omitting
  its execution scope. Older backend compatibility paths still validate the
  workspace layout namespace.
- Local workspace leases pin the native process cwd, recheck the physical
  workspace path, and reject another cwd, a replaced workspace path, use
  after release, and process launches after cancellation.
- Runtime prompts and a non-secret environment field carry the validated
  execution scope. MCP authority is enforced by the backend, not by prompts
  or an Agent-editable environment variable. Computer credentials list and
  manage only that Computer's standalone work; Project runs default to their
  admitted Project and cannot escape into standalone work. Standalone creates
  inherit the authenticated Computer, and returned links use workspace URLs.
- `workspace-scope` is advertised by the daemon and included in the rebuilt
  local installer bundle so older local clients are reported outdated.

RED: three backend MCP cases reproduced cross-Computer access and Project
creation escaping into standalone work. The local native-process tests also
failed: an acquired lease started in the daemon's cwd, and cancellation did
not prevent a process launch. The new daemon command tests initially failed
compilation because no authoritative workspace contract or validator existed.
All corresponding cases now pass.

Validation for this follow-up:

- 41 focused backend MCP/protocol, scope-construction, capability-parity, and
  architecture tests passed; a subsequent final scope/invariant run passed
  all 30 cases. The workspace/task regression run passed 63 cases.
- All seven real MCP transport cases passed, including standalone local
  file and native IPC transports, with local sockets enabled outside the sandbox.
- The package regression run passed all 1,065 cases using
  `node --test --test-force-exit --test-timeout=120000`. Force-exit was needed
  because the daemon test process retained a background handle after its
  assertions completed.
- After adding the local lease checks, the focused local runtime, shell,
  workspace, and shared Agent Runtime contract run passed 30 cases. The added
  legacy compatibility test passed separately; daemon scope-validator coverage
  is 100% lines/functions and 88% branches.
- Core/daemon builds, compiled TypeScript tests, backend mypy, Ruff, and
  `git diff --check` passed. The local installer bundle was rebuilt after the
  final runtime changes.

Host mode (`sandboxMode: none`) still gives subprocesses the operating system
permissions of their owner. Pinning cwd and enforcing Relay tool scope does
not prevent an arbitrary shell command from accessing other host paths; strict
OS filesystem isolation requires a sandbox. Existing local daemon processes
must be updated/restarted to load the rebuilt code.

## Review fixes: enforced scope and legacy links

The review found five gaps: updated daemons rejected recorded legacy layouts;
new REST Automations could omit Computer placement; old daemons could ignore
scope; Task Thread deep links could lose the addressed Thread; and missing
legacy record links could render an empty page.

The fixes preserve legacy layouts only through a backend-issued `legacyLayout`
field, require `workspace-scope` before publishing any agent run, require an
explicit valid Computer or Project when creating/converting an Automation, and
preserve Thread selection until its detail resolves. Missing unscoped records
return to the Computer picker. New Computer Tasks with `createSession: true`
save the selected Computer's root and their durable Task directory.

Regression evidence:

- RED: backend scope tests failed seven cases (four missing capability refusals,
  three missing legacy authorizations); daemon scope tests failed the legacy
  resume case; route tests failed four cases (older Thread and three missing
  record variants). API reproducers also demonstrated unscoped creation,
  conversion, malformed Computer identities, and the wrong new-Thread root.
- GREEN: `pytest backend/tests/api/test_issue_triage.py
  backend/tests/unit/test_run_workspace_scope.py
  backend/tests/unit/test_task_workspace.py -q` verifies those backend paths,
  including actual API dispatch refusal without publishing an old-daemon command.
- `npm run test:react -w web -- interaction-tests/workspaceRouting.test.tsx`:
  19 passed, including hydration followed by canonicalization of an older Thread.
- `node --test --experimental-test-coverage
  --test-coverage-include='**/src/run-workspace.js'
  dist/packages/relay-daemon/tests/run-workspace.test.js`: 5 passed;
  100% line/function coverage, 88.52% branch coverage.
- The complete compiled TypeScript regression run passed 3,169 tests with
  local sockets/process inspection enabled, using `--test-force-exit` and
  `--test-timeout=120000`. The complete React run passed 1,022 tests.
- The production web export passed with `npm run build -w web -- --webpack`.
  The default Turbopack build could not bind its local CSS-worker port inside
  the sandbox. The installer/MCP transport API run passed all 31 tests with
  local sockets/native process access enabled.

Modern daemon test fixtures explicitly advertise the newly mandatory capability.
Automation fixtures explicitly provision/select a Computer and place their
runner there; legacy store-level fixtures remain available to test compatibility.
The host-mode filesystem limitation described above is unchanged.

Final backend verification covered the 4,019 collected tests in unit/API batches
and focused reruns: 3,953 passed and 66 were skipped by their environment gates.
The final workspace regression target passed 59 tests; the final daemon API,
start-recovery, and workspace API recheck passed 118. Ruff, mypy (459 source
files), web type checking/ESLint, and `git diff --check` passed. The Computer
installer bundle was rebuilt. Existing daemon processes need an update/restart
to load the scope enforcement and legacy-layout support.

## E2E review follow-up: Thread reloads and Project execution actions

The live browser review reproduced a standalone Thread stuck on Loading after
its real summary returned `projectId: null`. The route guard now normalizes
absent Project identity before comparing scopes. Project-roster work now offers
Run now/Retry without requiring an individual assignment override, and the
Project dashboard opens its own Tasks tab rather than linking to the retired
global board. The dashboard action uses matching English and Chinese copy.

Migrating the older browser suite also exposed lost Files-tab/filter state
when a legacy record moved into its owning workspace. Relocation now preserves
route-owned panel and filter parameters while replacing scope coordinates.
Computer Task drawers use `tab`; Project drawers keep `recordTab`, leaving the
Project's `tab` available for its own section navigation.

RED evidence: the new focused tests failed on the null Project summary,
Project-roster run action, and dashboard destination. Three additional route
cases failed because relocation discarded selected record tabs and filters.
Those exact targets passed after the fixes.

The browser fixtures now explicitly select a Computer or Project. Tests for
removed cross-project boards and Project Thread redirects were migrated to
workspace isolation, canonical links, and retained filter/tab state. Existing
filter, preview, recovery, layout, and connection-access checks still run;
none were skipped or marked as expected failures. The final fixture correction
supplies a complete Task response, and the phone toolbar test waits for finite
drawer motion rather than an infinite status pulse.

Final validation:

- All 214 browser recovery/workspace tests passed together (zero skipped,
  unexpected, or flaky tests).
- All four real-backend/daemon E2E tests passed: concurrency and cancellation;
  standalone Thread reload plus real summary polling; Project-roster Automation
  execution and dashboard navigation; and Computer/Project work directory
  isolation plus Files-tab deep links.
- The controlled native child records its real cwd and `RELAY_WORKSPACE_SCOPE`;
  the E2E assertions check these against the stored Computer, Project, Task,
  and Automation identities. The harness uses disposable SQLite/workspace
  state and no external model calls.
- All 1,027 React interaction tests and 2,100 web Node tests passed.
- Route-guard coverage: 100% lines/functions, 97.67% statements, 92.38% branches.
- Production webpack export, web TypeScript, ESLint, the changed CSS lint, and
  `git diff --check` passed.

Browser reports and traces for this follow-up are under
`output/playwright/workspace-fixes/`; the real server harness removes its
disposable backend, daemon, and workspace when the suite exits.
