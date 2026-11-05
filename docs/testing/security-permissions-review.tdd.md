# Personal-space permissions and security review

Reviewed on 2026-11-05. The reported production symptom was an admin seeing
automation `6935d642-5d6a-45d7-af9e-1a9332aa9839` belonging to another User.
The required policy includes owner-only details, even for admins.

## Policy and fixes

| Surface | Enforced boundary |
| --- | --- |
| Personal Task, Automation, Thread, Project lists | Owning User only; SQL task filtering runs before pagination |
| Details, events, actions, files, artifacts, recovery, webhook secrets | Owning User only; knowing an ID, being the assignee, or being an admin grants no exception |
| Dependency and Automation occurrence summaries | Foreign records and foreign linked Thread artifacts are omitted |
| Task execution | Owner and execution User must agree, including legacy manual starts, linked Thread creation, and scheduler dispatch |
| Personal Computer | Only its owner can execute or browse its storage; admin fleet management remains separate |
| Unscoped Computer storage | Legacy computer-root file routes refuse all reads; Task, Thread and Project routes enforce resource ownership |
| Fleet monitor | Run identifiers, runtime and timing remain; Thread IDs, goals and run workspace paths are omitted |
| Daemon registration | A node credential cannot mint or replace a human UI credential |
| Legacy shared credential | A secret used as both node and UI credential cannot authorize human actions |
| Cookie plus stored bearer | The authenticated Account takes precedence over a bearer for another User |
| Browser Account transition | A fresh query cache and artifact viewer per Account; stored UI credentials and selections are cleared |

The browser cache boundary also contains late mutations from the previous
Account. Canceled authentication probes cannot clear a newly signed-in
Account's credentials. Auth capability updates still reach the signed-in cache.

The legacy unscoped computer-root file endpoints now return 403, including
for the Computer’s owner, because a storage root can contain other Users’
work. Record-scoped workspace endpoints remain available.

No schema migration or ownership rewrite is included. Legacy delegated Tasks
remain stored but cannot dispatch as another User. A legacy browser relying on
a shared node/UI secret must sign in with an Account; node transport
authentication continues to work.

## Reproduction evidence

Regression tests drove the actual HTTP, routing, database, and browser paths.
RED checkpoints on this branch include:

- `3e34e694`, `1aff3c6f`: foreign Automation and personal Task list visibility.
- `c2ca6618`, `aa201b09`: personal collections and private Computer execution.
- `55be10fd`, `685ce37c`: node-to-human credential escalation and shared secrets.
- `d47cecb3`, `a59e122f`: cached private content, late mutations, open artifacts,
  and stored credentials crossing browser Account changes.
- `68365132`, `f52829be`: admin access by ID, foreign linked artifacts, and
  cross-user Task dispatch.

Additional RED runs reproduced legacy sandbox Thread reopening, private run
contents in the fleet monitor, managed and owned unscoped storage browsing, and linking a private
Task to a Thread owned by its assignee. Each was refused after the corresponding
guard was added. Existing positive fixtures now authenticate as the resource's
owner; explicit negative admin/assignee cases retain the stricter assertions.

## Verification

Commands and results are recorded below. A passing regression suite verifies
the covered paths; it is not a claim that a repository-wide security review
can prove the absence of vulnerabilities.

- Broad Python backend run: 3,554 passed, ten skipped, seven failures. One
  ownerless/admin-resume fixture was corrected; the other six exposed an
  ordering regression in the new dispatch guard. Active execution is now
  recognized before assignment validation, preserving its reservation. The
  affected suites were rerun successfully; the broad suite was not repeated
  after these final changes.
- Task, team and owner-detail suites: 210 passed before the final added guards.
- Agent, daemon, webhook and dispatch compatibility suites: 165 passed.
- Final owner-detail, personal-resource, retired storage-route, daemon,
  anonymous/admin-route, layering and module-size checks: 161 passed.
- Final dispatch lifecycle, task dispatch, automation matcher and owner-detail
  checks: 116 passed, including all seven cases that failed in the broad run.
- Personal-resource, anonymous/admin route coverage, layering, module-size and
  routing checks: 70 passed; subsequent owner/route/layer checks: 38 passed.
- Full React interaction suite: 793 passed across 136 files.
- Focused Account isolation/authentication coverage: 98.03% lines, 88.09%
  branches, 93.33% functions across `PersonalSpaceProvider.tsx` and
  `useAuthSession.ts` (all configured 80% thresholds passed).
- Production TypeScript/web build: passed. Built Node tests: 2,918 passed,
  two unrelated source assertions failed in unchanged `messageBlock.test.ts`
  and `taskBoardReviewFixes.test.ts` (operation recovery keys and persisted
  view source patterns). The full TypeScript command therefore remains red.
- Backend Ruff: passed. Backend mypy: no issues in 404 source files.
- Final web TypeScript check (`tsc -p web/tsconfig.json --noEmit`): passed.
- Modified frontend files: ESLint passed. Full web ESLint retains an error in
  unchanged `ComposerImages.tsx:28` (`react-hooks/set-state-in-effect`) and
  five warnings.
- Deployment mock tests, `bash deploy/tests/run.sh`: passed.
- Vendored dependency regression tests: nine passed.
- `npm audit --registry=https://registry.npmjs.org`: zero known vulnerabilities.
- `pip-audit` against the installed backend environment: no known
  vulnerabilities; the local unpublished `relay` package is not on PyPI.
- `git diff --check`: passed.

## Broader review

The review covered authentication and authorization routes, personal-space
queries, linked-resource projections, daemon/human credentials, execution
admission, Computer control and file reads, browser identity transitions,
dependency advisories, and deployment script tests. Existing validation and
boundary tests cover request bodies, path confinement, webhook authentication,
chat identity ownership, anonymous routes, and admin-only configuration.

Bandit scanned the Python runtime. Its five medium findings were reviewed:
four SQL construction findings use fixed SQL identifiers with bound values,
and the timeout finding refers to a local `requests` mapping rather than an
HTTP request. Lower-severity findings were also inspected (assertions,
non-secret labels, non-cryptographic scheduling randomness and operator
subprocess use). A credential-pattern scan of 2,337 tracked text files found
no matching private keys or service-token patterns. This does not audit Git
history, production secrets, or third-party infrastructure configuration.

Dependency updates remove the audited npm and Python findings. `deepmerge`
has no upstream release fixing
[GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), so the
MIT-licensed upstream implementation is vendored with safe own-property writes
and prototype-pollution regressions. Its provenance and patch are documented in
`tools/vendor/deepmerge/README.md`. The minimatch override uses the fixed version
for [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249).

All changes and verification are local. Production data was not inspected or
modified, and no deployment or push was performed. After release, verify with
the reported admin Account that the Automation is absent from personal lists
and its direct detail/file/action routes refuse access.
