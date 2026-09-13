# Handoff lifecycle completion evidence

This slice closes the previously listed delayed-dispatch, terminal-acknowledgement,
and cooperative process-exit gaps. It does not authorize a live rollout.

## Executed RED/GREEN checkpoints

| Guarantee | RED checkpoint | GREEN checkpoint and evidence |
| --- | --- | --- |
| Delayed manual dispatch cannot overwrite completed work | `b019757f`: 4 failures | `efe10273`: manual cases pass |
| Scheduler uses the same atomic result fence | `be8d3e9d`: 1 failure | `022659e7`: 79 dispatch/scheduler/API tests pass |
| Durable terminal acknowledgement releases a cancelled reservation without rewriting the session | `412f4653`: 3 failures | `87fabd11`: 5 focused tests pass |
| Timeout/retirement does not release a delivered writer | `7e639e72`: 2 failures | `631fcd67`: focused cases pass |
| Stopping commands are not redelivered after lease expiry | `b2932ac1`: 2 failures | `fbfb1e9b`: 7 focused tests pass |
| POSIX child cannot outlive a cancelled parent in the same execution group | `1c5408df`: child-survival failure | `b8b2e03f`: process-group tests pass |
| Broken BoxLite output cannot acknowledge before exit | `b8b2e03f`: premature-return failure | `1dc2343d`: both selected daemon tests pass |
| Late success cannot override a durable stop | `1dc2343d`: 4 failures | `be7ff071`: 14 focused tests pass |
| Stop intent survives a crash before command publication | `c11ca1c5`: 2 failures | `8394d2ac`: all 236 registry tests pass |

Store scenarios cover local and database implementations. Tests simulate durable
crash boundaries and real POSIX subprocess cancellation; the BoxLite exit-wait
regression uses an execution-handle test double, not a live VM.

## Final verification

`npm test` passed production builds/typechecks, 1,437 TypeScript tests, 19 React
tests, and all 1,309 Python tests (154.61s for its Python phase).
The independent full-backend coverage run passed all 1,309 tests in 162.89s.
Combined statement/branch coverage: dispatch result guard 87%, daemon store 85%,
task store 90% (87% across these modules).

```sh
npm test
uv run --project backend --extra dev --with coverage coverage run --branch --source=relay.services.dispatch_results,relay.persistence.daemon_store,relay.persistence.task_store --data-file=/tmp/relay-lifecycle-coverage -m pytest backend/tests -q --tb=short
uv run --project backend --extra dev --with coverage coverage report --data-file=/tmp/relay-lifecycle-coverage
npm audit --registry=https://registry.npmjs.org
git diff --check
```

Dependency remediation updates the lockfile within compatible declared ranges
and the explicit sharp override to 0.35.4. `npm audit fix` reports zero known
vulnerabilities, including development dependencies. This is an audit snapshot,
not a claim that dependencies are vulnerability-free.

## Rollout and boundaries

- Pause admissions, apply `20260913_0068`, and upgrade every backend replica and
  daemon before relying on the combined guarantees. Duplicate active owners
  require normal lifecycle reconciliation; do not clear live-owner metadata.
- Stop intent does not release ownership. If execution exit cannot be confirmed,
  the run remains reserved; an operator must establish that the writer is stopped
  before recovery. No live migration or deployment was performed here.
- Local process-group cleanup is POSIX-only. Escaped/detached writers outside the
  group, unrelated processes, Windows process trees, and external side effects
  are not covered. No API credential revocation is implied.
- Autonomous child delegation and automatic historical-record repair remain
  separate product work, not implicit additions to handoff recovery.

This report supersedes the unfinished dispatch/termination items in the earlier
`task-execution-revisions.tdd.md` evidence snapshot.
