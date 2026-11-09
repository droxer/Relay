# Daemon transport implementation evidence

Source: `workflows/server-client-reliability.md`. Implementation date: 2026-11-09.
The reference performance and platform acceptance matrix remains unverified;
the functional checks below do not certify that matrix.

## Behavior and regression evidence

| Guarantee | Tests / evidence |
| --- | --- |
| Output survives a killed daemon after its durable completion boundary | `report-reliability.test.ts`: child process SIGKILL and restart replay |
| No deletion without matching report identity and payload proof | `report-reliability.test.ts`, `test_report_acceptance.py`: missing proof, digest mismatch, duplicate/conflicting identity |
| Receipts commit atomically with output effects | Injected append/group failure, retry, missing predecessor, concurrent independent PostgreSQL registries |
| Exit evidence commits before workflow work can acquire unrelated resources | PostgreSQL independent-connection commit-visibility regression |
| Rejected reports survive restart and stop retrying | Quarantine, blocked successor, unrelated progress, explicit audited retry/discard tests |
| Quota/free-space protection and hysteresis | `report-storage.test.ts`; crossing chunk retained, shutdown reserve, final-report space |
| Contact loss does not rerun or terminate a durably fenced execution | Watchdog tests; real HTTP outages of 1, 5, and 30 seconds; rejected terminal and lost poll-response regressions |
| Cancellation remains responsive and proves process-tree exit | UI cancellation integration test with SIGTERM-ignoring parent/child and ten-second force deadline |
| Batch replay preserves per-report proof and independent terminal delivery | Batch receipt tests and negotiated live-batch daemon integration |
| One incident updates through recovery without resetting read state | Monitor restart/60-second outage/10-second recovery tests; notification-store update regression |
| Diagnostics stay private | Owner, unrelated user, personal-hardware admin denial, shared-hardware admin tests; anonymous route-auth sweep |
| Brief is usable at desktop and phone widths | `inlineNotices.spec.ts`: light 1440 px and dark 390 px; screenshots visually inspected |

Observed RED cases included missing durable output, permanent-rejection deletion,
lost poll responses, cancelled start admission, a failed batch starving unrelated
work, the storage crossing chunk being discarded, and workflow finalization
running before its receipt was committed. Each has a passing regression.
Upload cancellation also exposed completion being rewritten as cancellation;
the existing outage regression now passes with the original outcome preserved.

## Verification

- Production package, installer, and web export build: passed.
- Canonical TypeScript tests: **3,073 passed** in the final bounded-concurrency run.
- React interaction tests: **906 passed in 152 files**.
- Transport policy/outbox/monitor/retry coverage: **90.47% lines, 84.05%
  branches, 83.58% functions** across the focused suite.
- Full Python run: **3,857 passed, 31 skipped, one migration assertion failed**.
  The assertion assumed a failed older downgrade would undo successful newer
  autocommit DDL. The test now exercises its own routing revision's boundary;
  migrations, schema drift, and receipt tests subsequently passed **34 checks**
  on disposable PostgreSQL. Later terminal-transaction regressions are recorded
  in the final validation addendum below.
- Browser recovery suite: **204 passed, one failed**. The remaining
  `taskStatus.spec.ts:110` expectation asks for “Ready for your review” before
  opening details. The unchanged `TaskReviewPanel` renders its compact details
  summary instead; it fails again when run alone. Transport brief checks pass.
- Ruff, mypy (457 source files), layering/module budgets, and diff whitespace
  checks passed during implementation; final reruns follow the last edit.

No TDD checkpoint commits were created during implementation because the
workspace sandbox grants read-only access to its Git metadata. PR packaging
uses a separate commit after the user requested the pull request.

## Performance probe and acceptance limits

`backend/tests/benchmarks/daemon_transport.py` launches disposable loopback
PostgreSQL schemas and one or two real HTTP backend replicas.
`tools/benchmark-daemon-transport.mjs` runs actual daemon loops in isolated
workers, with three synthetic Agent Runtime streams per daemon and configurable
100 ms RTT/fault injection. Synthetic agents fulfil the normal work-result
contract. It records missing samples, duplicate launches, and p50/p95/p99;
missing acknowledgements are failures rather than dropped measurements.

Earlier probes exposed test-fixture transaction wrapping and missing synthetic
work reports; those artifacts are diagnostic runs, not acceptance evidence.
The final harness observes publication's existing commit without widening its
transaction. Local load runs also exposed database lock contention in terminal
receipt handling, motivating the post-commit finalization regression and fix.

The machine used has 11 shared CPU cores running macOS. It does not provide the
spec's isolated reference resource allocation. Do not claim the 100-daemon,
10-minute SLO, 20-cycle recovery percentile, full backlog drain deadline, or
Linux/Windows/reboot/storage-device fault coverage from these smoke probes.
Those require running the documented matrix on the specified environment.

## Final validation addendum

- Backend event lifecycle/registry/layering/module regression run: **370 passed**.
- PostgreSQL final receipts, concurrent replicas, lock ordering, commit
  visibility, and schema parity: **34 passed**. The local lock-exclusion and
  anonymous-route/invariant run passed **26 checks** (two PostgreSQL-only
  checks skipped there and covered by the PostgreSQL run).
- Final ruff, mypy (457 files), JavaScript syntax, and diff checks passed.
- Final focused outbox/policy/monitor/retry run: **51 passed**.
- Final canonical Node run (`--test-concurrency=4`): **3,073 passed**, zero
  failures. Bounded concurrency avoids an unrelated file-bridge stress-test
  timeout observed while multiple load probes and the unbounded suite ran
  simultaneously. React remains **906 passed**.
- Two-replica healthy smoke: five daemons × three runs, 100 ms RTT, five-second
  warmup and 35-second sample. **45 command samples**, command p95 **246 ms**;
  **4,504 output samples**, acknowledgement p95 **957 ms**. No missing samples,
  duplicate launches, or fixture errors. Artifact:
  `/tmp/relay-transport-cadence-final.json`.
- Two-replica five-second connection blackhole: same five-daemon workload.
  Recovery requires both a successful poll and first accepted replay. Across
  five daemons, recovery p50 **1,870 ms**, p95/max **4,117 ms**; no missing
  acknowledgements, duplicate launches, or fixture errors. All **3,922** measured
  output records eventually arrived. Outage/backlog output latency is recorded
  separately, not represented as healthy latency. Artifact:
  `/tmp/relay-transport-immediate-recovery.json`.
- Recovery now requests an immediate empty poll after a restored heartbeat;
  otherwise an idle long poll could wait for new work and exceed the recovery
  deadline. The integration regression passes.

These are reduced smoke profiles, not the 100-daemon reference acceptance run
or a 20-cycle recovery percentile. The full platform/fault matrix and the
10 MiB-per-daemon drain deadline remain outstanding acceptance work.

Apply migration `20261109_0122` before deploying this backend; deploy the backend
before updated daemon bundles. Legacy peers remain supported and explicitly
unverified for payload-bound durable receipts.
