# Daemon runtime supervision evidence

Source: [daemon reliability and runtime scaling](../proposals/daemon-runtime-scaling.md).
This change implements live-run supervision, execution/transport extraction,
critical background-task failure handling, and independent guest/boot limits.
It does not claim production capacity at 20 runs or implement a new storage format.

## Guarantees and evidence

| Behavior | Test target | RED evidence | GREEN evidence |
| --- | --- | --- | --- |
| Durable admission precedes execution; duplicates and runtime saturation cannot start another run | `run-supervisor.test.ts` | TypeScript could not resolve the new supervisor module | Supervisor tests pass |
| Workspace waiting consumes capacity and remains cancellable | `run-supervisor.test.ts` | Same missing-interface compile RED | Supervisor tests pass |
| A partial admission write fails closed; drain cancels preparation; duplicate lease refresh preserves existing behavior | `run-supervisor.test.ts` | Characterization added during extraction | Supervisor tests pass |
| Shutdown aborts uploads even after terminal evidence is durable | `run-supervisor.test.ts` | New test observed `aborted === false` | Test passes after separating shutdown stops from storage-pressure stops |
| Native boot concurrency is independent of resident capacity, including late completion after timeout | `guest-pool.test.ts` | Both new boot-budget tests failed against the original pool | All 14 pool tests pass |
| Critical task failure/completion triggers drain; shutdown errors do not invoke the handler twice | `background-task.test.ts` | Missing-module compile RED; throwing-handler test observed two calls | All three tests pass |
| Invalid resource budgets fail validation and service profiles retain both new settings | `run-admission.test.ts`, `runtime-profile.test.ts` | Missing `resourceLimit`; profile contained `{}` instead of the two settings | Both targets pass |
| A rejected poll followed by fatal re-registration stops execution before returning an error | `daemon.test.ts` | Added as integration characterization | Focused integration test passes |

Commands used:

```sh
node node_modules/typescript/bin/tsc -p packages/tsconfig.json
node --test dist/packages/relay-daemon/tests/run-supervisor.test.js
node --test dist/packages/relay-daemon/tests/guest-pool.test.js
node --test dist/packages/relay-daemon/tests/background-task.test.js
node --test dist/packages/relay-daemon/tests/run-admission.test.js
node --test dist/packages/relay-daemon/tests/runtime-profile.test.js
node --test --test-name-pattern='unexpected fatal poll' dist/packages/relay-daemon/tests/daemon.test.js
```

Combined focused run: **32 passed, zero failed**. Node test coverage, including
only `run-supervisor.js`, `guest-pool.js`, `background-task.js`, and
`run-admission.js`: **94.99% lines, 90.79% branches, 82.54% functions**.
This is focused coverage, not whole-repository coverage. Execution and transport
extractions are also exercised by daemon integration tests. A source-body
comparison against pre-change revision `903706e9` verified all 11 extracted transport function bodies were
unchanged and execution differed only in injecting its two output settings.

The initial compile-RED checkpoint commit was rejected by the repository's
TypeScript pre-commit hook. The hook was not bypassed. This report preserves that
RED evidence together with the later runtime RED/GREEN results.

## Environment and checks

Tests requiring Unix sockets cannot run in the restricted sandbox (`listen EPERM`);
the integration suites were run with local socket/process permissions. Dependencies
were copied from the existing local installation into this worktree, including
nested web dependencies, because the static web build cannot follow dependencies
outside its filesystem root. No package manifest or lockfile changed.

`npm audit --offline --ignore-scripts` reported zero vulnerabilities. This uses
locally available audit data and is not a fresh online advisory check.
`git diff --check` passes.

Python regression suite: **4,216 passed, 32 skipped**, using the existing Python
environment with this worktree's `backend` on `PYTHONPATH`. Deprecation warnings
were emitted by dependencies. Command:

```sh
PYTHONPATH=backend /Users/feihe/Workspace/Relay/backend/.venv/bin/python -m pytest -c backend/pyproject.toml backend/tests -q
```

The full daemon run also caught two compatibility regressions during extraction:
a fenced start was logged as admitted, and a cancellation report started before
shutdown lost its lifetime cancellation signal. Both were fixed, and the existing
`a cancel and a recovered start in one poll never launch cancelled work` and
`cancellation delivery started before shutdown stops retrying when the daemon exits`
tests pass.

Final `npm run test:ts`: **3,234 Node tests passed, zero failed**, followed by
**1,151 React tests passed across 175 files**. The command also completed the
package builds, installer bundle build, production web static export, and
TypeScript compilation. No TypeScript tests were skipped.

## Scaling measurement and remaining gate

`node tools/benchmarks/daemon-runtime.mjs` ran on macOS arm64, Node v26.8.2,
concurrently with regression tests. It uses disposable private storage and no
backend/agent credentials. At capacities 1, 5, and 20, each point completed 100
synthetic runs, retained all 100 terminal reports, and left no pending journal.
P99 event-loop delay was approximately 50, 266, and 1,005 ms, respectively.
Cold fence lookup pairs stayed below 0.3 ms p99 at 10k, 100k, and 1m histories.

The 20-run result exceeds the proposed 600 ms gate for a 6-second heartbeat.
Defaults remain unchanged. Persistence offloading, near-quota output recovery,
long outages, real Agent Runtimes, and Windows/BoxLite hardware validation remain
required before claiming higher supported capacity. Synthetic throughput is not
agent throughput, and concurrent regression load makes this an initial baseline.
