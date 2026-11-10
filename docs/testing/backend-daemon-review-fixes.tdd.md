# Backend and daemon review fixes

Source: the backend/daemon review and the user's request to fix its three findings.
Journeys were derived from that review on 2026-11-10.

| Guarantee | Regression | Evidence |
| --- | --- | --- |
| Updating a project brief preserves host files referenced by workspace symlinks or hardlinks | `project-context.test.ts` | Both link cases failed before the atomic replacement and pass afterward. |
| A symlinked control directory cannot redirect writes or stale-brief removal | `project-context.test.ts` | Both operations failed the new assertions before the directory check and pass afterward. |
| Strict terminal delivery compacts HTTP 413 responses without losing exit evidence | `terminal-outbox.test.ts` | Live, replay, and batch cases failed before the fix and pass afterward. |
| Compact receipts remain payload-bound across lost acknowledgements and daemon restarts | `terminal-outbox.test.ts` | All three delivery cases retry deterministic compact identities, retain reports without receipt proof, and remove reports only after verified acceptance. |
| An explicit zero outage grace in the environment stops execution after lease expiry | `daemon.test.ts` | The regression fails against an isolated generated copy with the old initialization (the run completes) and passes with the fix (the run is cancelled). |

The outage integration test initially encountered the sandbox's local-socket
restriction before reaching execution. Its meaningful RED and GREEN runs used
local-socket access. Temporary generated copies used for RED verification were
removed afterward.

## Implementation

- Replace the project mirror using an exclusively created temporary file and a
  rename; reject a symlinked `.relay` directory before writing or removing files.
- Enable compact terminal retries with strict receipts. Give each compact
  representation a deterministic receipt identity distinct from its full payload,
  so a lost acknowledgement cannot cause a digest conflict on retry.
- Fall back to individual delivery when a replay batch receives HTTP 413.
- Resolve the programmatic/environment grace setting before deciding whether
  unbounded outage continuation is enabled. Unconfigured behavior is preserved.

## Verification

- `npx tsc -p packages/tsconfig.json`: passed.
- `node --test dist/packages/relay-daemon/tests/*.test.js`: 690 passed,
  two unrelated model-discovery assertions failed. Both failures reproduce alone
  in `agent-models.test.js`, which imports the unchanged model-discovery module.
- Focused project-context, terminal-outbox, and report-reliability tests:
  59 passed after the final assertion updates.
- `backend/.venv/bin/python -m pytest backend/tests/unit/test_report_acceptance.py -q`:
  15 passed, two PostgreSQL-only checks skipped.
- Coverage command: `node --experimental-test-coverage
  --test-coverage-include='dist/packages/relay-daemon/src/project-context.js'
  --test-coverage-include='dist/packages/relay-daemon/src/terminal-outbox.js'
  --test dist/packages/relay-daemon/tests/project-context.test.js
  dist/packages/relay-daemon/tests/terminal-outbox.test.js
  dist/packages/relay-daemon/tests/report-reliability.test.js`.
  Result: 90.40% lines, 83.76% branches, 81.82% functions for those two modules.
  This does not measure the entire daemon entrypoint or backend.
- Scoped `git diff --check`: passed.

No checkpoint commits were created: the workspace grants read-only access to
Git metadata. This report preserves the RED/GREEN evidence without commits.
No backend runtime, API contract, or database schema changes were necessary.
Previously quarantined reports continue to require the existing explicit retry
operation; this change does not silently discard or reopen quarantine evidence.

## Second review fixes

Source: the second review and the user's request to fix its three findings.

| Guarantee | Regression evidence |
| --- | --- |
| A FIFO or symlink at any verdict, next-steps, or setup control-file path cannot block or redirect the daemon's read | `control-file.test.ts`: three reader types, FIFO subprocess deadlines, leaf links, parent-directory links, and byte-cap checks. |
| A completed, failed, or cancelled run remains replayable through age/count pruning | `test_report_acceptance.py`: keep command/run rows during partial output replay, then prune after the final sequence is accepted. |
| Terminal receipts cover captured output from all exit paths | `terminal-outbox.test.ts`: batched output, collaboration events, lease isolation, restart, and no pending output. |
| Verdict rejection reaches finalization over both HTTP transports | `test_report_acceptance.py`: single-event and batch requests preserve `run_id_mismatch`; malformed diagnostic metadata never rejects exit evidence. |

Before production edits, all 12 new TypeScript cases and all six backend
regressions failed for the reported behavior. The fixes add a shared bounded,
nonblocking regular-file consumer, terminal `lastOutputSequence` metadata,
retention filtering against the accepted contiguous cursor, and validated
`roundResultRejected.reason` parsing. SQL filtering transfers only IDs; an
existing scalability assertion now checks SELECT projections rather than
rejecting references to JSON metadata in WHERE clauses.

Validation after the final changes:

- TypeScript compilation: passed (`npx tsc -p packages/tsconfig.json`).
- Focused TypeScript/control-file/outbox suite: 79 passed. Coverage across
  `control-file`, `round-result`, `project-setup`, `next-steps`, and
  `terminal-outbox`: 92.58% lines, 85.91% branches, 85.71% functions.
- Broader backend regression/invariant suite: 452 passed, two PostgreSQL-only
  tests skipped. This includes registry, receipt, parser, scalability, schema
  scalability, layering, and module-size tests.
- Final focused backend rerun after using BIGINT for sequence comparisons and
  testing the full safe-integer wire range: 155 passed, two skipped.
- Ruff and mypy: passed; mypy checked 458 source files.
- Scoped whitespace checks: passed.

Older durable terminal records without an output watermark remain protected
conservatively: there is no sound proof that all their output reached the
backend. New clients permit normal pruning once replay finishes. No database
migration is needed. Roll out the backend update before daemon updates so its
retention protection is present when terminal watermarks arrive.

Full daemon validation completed with
`node --test --test-force-exit dist/packages/relay-daemon/tests/*.test.js`:
704 passed, two unchanged model-discovery assertions failed (706 total).
The initial run without the exit guard finished reporting its daemon cases
but retained a test-process handle; it was stopped before this guarded rerun.

## Model-discovery test isolation

The two remaining model-discovery failures were reproduced independently.
Both tests assumed vendor endpoints while `discoverAgentModels` correctly read
custom endpoints loaded from the developer's dotenv configuration. No runtime
change was needed: suite hooks now pin vendor endpoint defaults and restore the
original environment after each case. The original model-list assertions remain
unchanged. An additional discovery-level regression checks custom endpoint
catalog filtering and reuse of its last successful catalog after an outage.

All 28 model-discovery tests pass with both the local environment and explicitly
supplied custom endpoint URLs. TypeScript compilation and whitespace checks pass.

Final daemon suite: `node --test --test-force-exit
 dist/packages/relay-daemon/tests/*.test.js` completed with **707 passed,
zero failed, zero skipped**. The two formerly failing model-discovery cases
are included in this clean run.

## Third review fixes

Source: the third backend/daemon review and the user's request to fix its three
findings. Regression tests first reproduced five process-recovery failures and
four lost-acknowledgement failures. A later rapid PID-reuse regression reproduced
one additional unsafe selection inside the former ten-second tolerance.

| Guarantee | Regression evidence |
| --- | --- |
| A clock jump cannot release a still-live process group | `exit-proof.test.ts`: forward/backward boot-estimate changes still probe the process; missing Windows process observations prove nothing. |
| Windows cleanup excludes a replacement root and its new children | `windows-process-tree.test.ts`: long-delay and rapid PID reuse, plus older orphan preservation and traversal of their descendants. |
| An identical accepted report remains acknowledgeable after command pruning or thread deletion | `test_report_acceptance.py`: terminal/output reports over both single and batch HTTP routes, without reapplying session effects. |
| Archived receipts cannot be used by another node, a bad token, a changed digest, or an unknown identity | The same HTTP/store regressions exercise these denial paths. |
| The receipt migration preserves data and has a viable downgrade | `test_retained_report_receipt_migration.py`: foreign-key-enabled SQLite upgrade, retry, command deletion, and downgrade restoring cascade after removing orphan receipts. |

Implementation: process exit requires actual absence evidence; historical boot
estimates are not reboot proof. Windows creation-time tolerance permits creation
before the recorded post-spawn observation, never afterward, and bounds children
of a reused root. Report receipts retain only node/command/report identities and
payload digests independently of command/thread history. Accepted retries still
require the current node credential and matching bound receipt before an
acknowledgement; no original report effects are re-applied.

Verification:

- Focused process-recovery suite: 13 passed; 88.55% lines, 97.78% branches,
  82.35% functions across `exit-proof` and `windows-process-tree`.
- Receipt and migration suite: 30 passed, two PostgreSQL checks skipped.
- Broader backend/API/invariant suite: 417 passed, 19 skipped. The skipped
  checks include PostgreSQL schema-drift/concurrency tests because the test
  database was unavailable. SQLite migration upgrade/downgrade was exercised;
  a live PostgreSQL migration was not.
- TypeScript compilation, Ruff, mypy (458 files), and scoped whitespace checks
  passed.

Apply Alembic migration `20261110_0123` before deploying this backend. Upgrade
removes the receipt-to-command cascading foreign key. Small receipt metadata is
retained independently; large command/run payloads retain their existing pruning
policy. Downgrade necessarily removes orphan receipts before restoring the old
foreign key. Historical receipts already lost to an earlier cascade cannot be
reconstructed by this migration.

The broad third-round daemon run exposed a timing-sensitive outage harness
assertion: it counted HTTP retry uploads as distinct completions. A focused
rerun passed, and a delayed-acknowledgement regression then exercised concurrent
live/replay copies explicitly. The fake backend now deduplicates payload-bound
receipt identities, matching the real backend; it still asserts exactly one
applied completion and rejects conflicting digests. Both outage regressions pass.

Final third-round daemon verification:
`node --test --test-force-exit dist/packages/relay-daemon/tests/*.test.js`
completed with **711 passed, zero failed, zero skipped** after the rapid-PID and
retry-race regressions. Alembic reports the single head `20261110_0123`.

## Fourth review fixes

Source: the fourth review and the user's request to fix its three findings.
The initial regression run compiled and executed five failing cases: failed
termination after spawn, Windows enumeration failure through operator release
and later recovery, run-token expiry, and refusal-cache invalidation.

| Guarantee | Regression evidence |
| --- | --- |
| A failed kill never counts as exit evidence | `process-supervisor-recovery.test.ts`: a real child remains alive after simulated libuv EPERM; the supervisor reports uncertainty and holds execution. |
| Execution settles only after verified cleanup or operator release | The same file covers permission recovery with retried termination, explicit reconciliation, Windows enumeration recovery, and failed spawn without reconciliation. |
| Windows enumeration failure cannot masquerade as successful cleanup | The Windows branch retains execution after root pipe EOF; CIM enumeration uses terminating errors. Without a process list, only the original ChildProcess handle is used for best-effort root termination. |
| Expiring MCP tokens refresh once for concurrent calls within the original run scope | `relay-mcp-lifecycle.test.ts`: advance time past the advertised expiry and assert one additional command/lease-bound issuance. |
| A late refusal cannot erase a newer token | An old in-flight 401 completes after refresh; later calls keep the fresh credential. |
| Refusal or transport failure never replays a tool write | Explicit 401, network-error, and 503 regressions assert one dispatch; only the next explicit call may acquire a replacement credential. |
| An ended lease cannot fall back to an expired credential | Credential reissuance refuses with 409 and no further tool request is sent. |

The daemon refreshes 60 seconds before advertised token expiry and coalesces
concurrent issuance. Older backends without expiry metadata retain compatibility;
a 401 clears only the credential used by that response, for a future explicit
call. Neither renewal failures nor uncertain request failures replay writes.
Tokens remain in daemon memory and every issuance rechecks the active command
and lease on the existing backend endpoint.

Verification:

- `npx tsc -p packages/tsconfig.json`: passed.
- Focused supervisor, process-tree, and MCP lifecycle suite: 31 passed.
- Focused coverage of `process-supervisor`, `relay-mcp-managed`, and
  `windows-process-tree`: 89.60% lines, 78.79% branches, 92.31% functions.
- Backend MCP API/protocol/transport integration: 18 passed. The initial six
  transport failures were sandbox socket-bind restrictions; rerunning with
  local socket access passed all tests.
- Full daemon suite with `--test-force-exit`: **722 passed, zero failed,
  zero skipped**.
- Scoped whitespace checks passed.

Windows cleanup regressions exercise the Windows branch using controlled
process-enumeration responses and real child processes on the local platform;
a native Windows/PowerShell environment was not available for validation.

## Standards review cleanup

Removed the ignored current-boot-estimate arguments from `localExitProven` and
`windowsExitProven`. Historical `ExecutionEvidence.bootAt` remains readable for
journal compatibility. Clock-jump regressions now mock the wall clock directly;
the exit decision still requires process absence evidence.

The final two-axis review found one minor standards smell (these obsolete
arguments) and no actionable spec findings. Before this cleanup, focused
validation passed TypeScript compilation, 94 daemon tests, and 147 backend tests
with two PostgreSQL-only checks skipped.

After removing the arguments, TypeScript compilation and all 13 focused
exit-proof/process-tree tests passed. Exit-proof line coverage was 96.23%.
The production npm dependency audit against the official registry reported
zero vulnerabilities; the configured mirror does not implement its audit API.

## CI Node 22 recovery-test cleanup

The PR's TypeScript job cancelled all five supervisor-recovery tests after the
first test's cleanup left a pending `close` promise with no referenced handles.
Operator reconciliation intentionally unrefs the child in production; the test
still owns termination and must keep that handle referenced while awaiting it.

Reproduction command: `npm exec --yes --registry=https://registry.npmjs.org
--package=node@22 -- node --test
dist/packages/relay-daemon/tests/process-supervisor-recovery.test.js`.
Before the test-only fix: zero passed, five cancelled, exit code 1, with
`Promise resolution is still pending but the event loop has already resolved`.
After re-referencing the child and subscribing to `close` before sending the
cleanup signal: five passed, zero cancelled, exit code 0. The same file had
passed on the developer's Node 26 runtime, which masked the CI-version failure.
TypeScript compilation and the production npm audit also passed.
