# Daemon runtime admission evidence

Source: the staged design in [daemon-runtime-scaling.md](../proposals/daemon-runtime-scaling.md).
Journeys were derived from the requested daemon scaling design.

## Guarantees

- Codex saturation leaves admitted work queued while Claude can use free Computer
  capacity. Releasing Codex capacity resumes the waiting assignment.
- Runtime limits survive database reload and apply to dispatch claims across
  independent store instances, including claims not yet published as commands.
- Invalid runtime configuration fails startup without echoing its contents;
  omitted limits preserve the existing Computer capacity behavior.
- A daemon capacity refusal retries the same assignment with a new command id.
  Durable replay cannot clear a newer attempt, and a mismatched lease is refused.
- A recorded human stop wins over capacity retry.
- A refused command cannot execute on redelivery after capacity opens.
- Background-service profiles retain runtime limits.

## RED evidence

`test_runtime_capacity.py` initially failed both delivery and cross-replica claim
assertions: the second Codex run was delivered/reserved despite a runtime limit of
one. Checkpoint: `d3b170c9` (`test: reproduce ignored runtime dispatch limits`).

The capacity-rejection test initially observed a failed request instead of a
queued assignment. The stop-race test initially observed a running request after
cancellation. Both failed before the corresponding finalization changes.

The TypeScript admission tests initially failed compilation because
`run-admission.ts` did not exist. The daemon replay test subsequently counted
three actual launches instead of two before refused command ids were fenced.

## GREEN evidence

Commands use the existing development virtual environment because dependency
installation from this worktree is restricted by network access.

- `PYTHONPATH=backend:backend/tests <dev-python> -m pytest backend/tests/unit/test_runtime_capacity.py backend/tests/unit/test_workspace_fair_scheduling.py -q`:
  16 passed, covering admission, persistence, retries, replay, stop races and workspace fairness.
- `node --test --test-name-pattern='runtime admission defers|rejects a second distinct run|refused report of a rejected' dist/packages/relay-daemon/tests/daemon.test.js`:
  3 passed, including actual runtime-launch counts and legacy-backend behavior.
- `node --experimental-test-coverage --test dist/packages/relay-daemon/tests/run-admission.test.js dist/packages/relay-daemon/tests/runtime-profile.test.js`:
  6 passed; `run-admission.js` has 100% line, branch and function coverage.
  This is focused coverage, not a claim of whole-repository coverage.
- `node node_modules/typescript/bin/tsc -p packages/tsconfig.json`: passed.
- `<dev-mypy> --config-file backend/pyproject.toml backend/relay`: zero errors in
  460 source files.
- Full backend suite, `PYTHONPATH=backend:backend/tests <dev-python> -m pytest backend/tests -q`: 4,062 passed, 32 skipped in 757.47 seconds.
- Registry and architecture checks: 293 passed.
- `<dev-ruff> check backend`: passed.
- `npm audit --offline`: no vulnerabilities reported from cached advisory data.
- `git diff --check`: passed.

The initial broad package run passed 1,073 tests and failed only the installer
bundle test because its generated archive had not been built. After compiling
packages and running `node tools/build-computer.mjs`, the bundle test passed.
Daemon tests require local Unix socket access; installer terminal tests require
`/dev/tty`. Sandboxed attempts reported permission errors and were rerun with
those local capabilities enabled.

The first GREEN checkpoint attempt was rejected by the local mypy hook's
incomplete worktree environment (missing stubs and five errors in untouched
files). The existing development environment type-checks the complete backend
successfully. The final implementation checkpoint `a6d63e25` passed every
applicable commit hook using that environment. No hooks or application
configuration were changed.

## Scope and residual risk

This change implements the admission stage. Per-run supervision extraction,
resource-based limits, credential cooldowns, and isolated Project worktrees
remain the next stages in the design. No hosted deployment or throughput
benchmark was performed. The new cross-replica tests use independent SQLite store
instances; PostgreSQL row-lock concurrency tests require a PostgreSQL test service.
Backend rollout precedes daemon rollout for retryable admission negotiation.
