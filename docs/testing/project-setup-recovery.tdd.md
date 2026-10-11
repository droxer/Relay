# Project setup recovery fixes

Journeys were derived from the setup review: an owner can dismiss a draft
without a late result reopening it; older runs and dispatch responses leave
replacement drafts alone; a definitive failure before delivery ends drafting;
and a daemon consumes only the proposal file assigned to its setup attempt.

The original shared-workspace concurrency finding was overstated:
`WorkspaceRunGate` already serializes execution in a project directory.
Attempt-specific proposal paths and setup-only cleanup are hardening on top of
that existing protection, rather than a replacement for serialization.

## RED and GREEN

Before the fixes, the API regressions reproduced a concurrent dismissal being
replaced by `proposed`, a newer draft being replaced by an old result, and a
pre-delivery failure leaving `setup.state` as `drafting`. The new path assertion
also failed because commands still used `.relay/project-setup.json`.
The compiled proposal-isolation test passed four existing tests and failed the
new test because consumption ignored an attempt-specific path.

Further regressions failed for replacement drafts without a thread, revisions
in the same thread, an old dispatch response attaching its thread to a new
draft, and simultaneous starts at the write boundary. These now use a draft
identity pinned in the manifest and checks inside the project mutation. A
separate fingerprint regression proved that identity metadata must be excluded
from request fingerprints to preserve retry equivalence.

The final focused Python run passed all 67 tests. Proposal and context helper
tests passed all six tests with 100% line, branch, and function coverage. Three
daemon integration cases passed for normal execution, setup execution, and an
agent exception.

| Guarantee | Test | Result |
| --- | --- | --- |
| Completion preserves dismissal and replacement drafts without bumping their revision | `test_project_setup_api.py::test_completion_rechecks_setup_inside_the_project_mutation` (four cases) | PASS |
| Definitive failure before delivery closes drafting | `test_project_setup_api.py::test_failure_before_delivery_closes_the_draft` | PASS |
| Dispatch responses cannot attach their thread to a replacement draft | `test_project_setup_api.py::test_dispatch_response_does_not_attach_its_thread_to_a_replacement_draft` | PASS |
| A concurrent start is rejected at the write boundary | `test_project_setup_api.py::test_start_rechecks_for_another_draft_at_the_write_boundary` | PASS |
| Draft identity does not alter request equivalence | `test_collaboration_service.py::test_setup_draft_identity_does_not_change_the_request_fingerprint` | PASS |
| Proposal consumption isolates attempts and rejects unsafe paths and malformed files | `project-context.test.ts` | PASS |
| Normal runs preserve proposal files; setup runs clean up only their own file, including on exceptions | `daemon.test.ts`: daemon scopes proposal cleanup to its setup attempt | PASS |

Commands:

```sh
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/unit/test_collaboration_service.py backend/tests/api/test_project_setup_api.py backend/tests/unit/test_project_setup.py backend/tests/unit/test_project_context.py backend/tests/api/test_project_context_api.py -q
npx tsc -p packages/tsconfig.json
node --test --experimental-test-coverage dist/packages/relay-daemon/tests/project-context.test.js
node --test --test-name-pattern='scopes proposal cleanup' dist/packages/relay-daemon/tests/daemon.test.js
git diff --check
```

## Broader verification

- `npm test`: blocked during the default Turbopack build by local port binding
  (`Operation not permitted`), including the permitted retry.
- `npm run build -w web -- --webpack`: production build and web typecheck passed.
- Compiled Node suites: 2,058 passed, two failed. Both failures were reported
  on HEAD in the handoff: `designGrid.test.ts` rejects the 720px breakpoint and
  `projectPage.test.ts` expects a different tab order. The additional malformed
  proposal helper test was added afterward and passed in the focused rerun.
- `npm run test:react -w web`: all 442 tests passed on the permitted rerun. An
  initial sandboxed run timed out in the unchanged roster interaction test;
  its isolated rerun also passed.
- `npm run test:py`: 2,356 passed, 16 skipped, two failed because installer
  subprocesses could not open `/dev/tty` in the sandbox. Both failures passed
  on a permitted rerun. The final fingerprint regression and its neighboring
  tests passed in the final 67-test focused run.
- `git diff --check`: passed.
- `npm audit --json --registry=https://registry.npmjs.org`: completed and
  reported 26 existing dependency vulnerabilities (one critical, 15 high,
  four moderate, six low). Dependency manifests and lockfiles are outside
  this change.

Coverage measurement is limited to the daemon proposal/context helpers; Python
coverage tooling is not installed. The backend concurrency tests inject a
competing write at the store mutation boundary and exercise the real database
and daemon completion endpoint. No real-agent browser E2E run was performed.
Existing edits were preserved; no TDD stage checkpoint commits were created.
