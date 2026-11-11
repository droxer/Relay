# Linked Project workspace scope regression

## Cause and scope

Project creation links an existing folder before creating the Project. Its
`links/<linkId>` therefore has a different id from the Project. The scope
validator introduced in `8d0e6409` only accepted `projects/<projectId>` or
`links/<projectId>`. It refused legitimate linked Project conversations,
Tasks, and Automation occurrences before starting their Agent Runtime.

This reproduces the reported `Run workspace scope mismatch` for linked
Projects. A failure in a canonical `projects/<projectId>` workspace would need
its command inspected separately; the regression tests cover that layout too.

## Contract and isolation

The backend copies the session's recorded directory into
`workspaceScope.projectWorkspaceSubpath`. It never reads this binding from
agent-supplied state. The daemon requires an exact path match, keeps the
Computer and Project-context checks, and refuses traversal and cross-layout
paths. Older commands retain their existing canonical-path validation.

The `project-workspace-scope` capability distinguishes corrected clients.
Linked Project execution requires it during command preparation and again
when a queued command is leased. Browsing retains its existing capabilities.

## RED evidence

Checkpoint `ba5c30cb` contains the reproducer before the production fix:

- `npx tsc -p packages/tsconfig.json && node --test
  dist/packages/relay-daemon/tests/run-workspace.test.js`: one failing test,
  with the exact `Run workspace scope mismatch` exception.
- `UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest
  backend/tests/unit/test_run_workspace_scope.py -q`: four failing cases;
  the three work types omitted the recorded directory, and the backend
  accepted clients without the corrected contract.

The API contract test additionally creates real Project records through HTTP
and passes backend-generated run commands to the actual TypeScript validator.
It covers both Project folder types and all three work types, and checks
that a different Project's directory is rejected.

## GREEN evidence

- Scope/Project backend regression selection: 64 passed, including the six
  Python-to-TypeScript command checks and capability loss before preparation
  and before delivery.
- Daemon scope tests: 7 passed; 100% line/function coverage and 91.30% branch
  coverage in `run-workspace.js`.
- Complete daemon integration target: 183 passed.
- Complete React interaction suite: 1,123 passed across 171 files.
- Complete compiled TypeScript suite: 3,199 passed using the documented
  `--test-force-exit --test-timeout=120000` runner options.
- Backend verification covered the initial 28 completed API files plus all
  254 remaining files in six isolated batches. All six batches passed
  (3,521 passed, 25 environment-gated skips). The initial run's three
  installer permission failures passed in the installer rerun below.
- Computer installer API suite with local subprocess access: 24 passed.
- TypeScript compilation, production web export with `--webpack`, backend
  Ruff, and mypy (459 source files) passed. The default Turbopack web build
  cannot bind its CSS-worker port in this environment.
- `npm audit --registry=https://registry.npmjs.org --audit-level=high` found
  zero vulnerabilities. The configured npm mirror does not provide an audit
  endpoint.
- `npm run build:computer` rebuilt the installer bundle; its manifest includes
  `project-workspace-scope`.

## Rollout and recovery

1. Deploy the backend and rebuilt Computer installer bundle together.
2. On affected personal Computers, run `relay update`. It restarts the daemon
   automatically. Managed Computers must also load the corrected daemon bundle.
3. Confirm registration advertises `project-workspace-scope`, then retry one
   failed Task before retrying the rest or the failed Automation occurrences.

No workspace rename, database migration, Project recreation, or file deletion
is needed. Updating does not itself retry already-failed work. Commands queued
before the fix retain their original payload; retry failed work after updating
to generate a fresh command with the recorded directory binding.

## CI follow-up: exact runtime scope assertions

The Browser/backend/daemon concurrency job in run `43007474806` failed two
Project assertions after the hotfix: the real runtime scope correctly included
`projectWorkspaceSubpath`, but the expected objects omitted it. The local
`CI=true npx playwright test -c playwright.concurrency.config.ts` run reproduced
both failures (two passed, two failed).

The Project Task and Automation expectations now include the Project's recorded
`workspaceSubpath`. Full-object equality is retained; standalone scopes remain
unchanged. The same real browser/backend/daemon suite then passed all four tests
with `CI=true` (30.2 seconds). This follow-up changes test expectations only.
