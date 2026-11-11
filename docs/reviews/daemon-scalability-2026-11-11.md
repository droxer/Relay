# Relay daemon scalability and reliability review

Implementation follow-up: the five findings below are addressed in this worktree. See [TDD evidence](../testing/daemon-scalability.tdd.md) and [resource budgets](../guides/node-heartbeats.md#daemon-resource-bounds). The findings and measurements below describe the reviewed baseline.

Reviewed commit: `688bafd3`, 2026-11-11. Scope: daemon admission, workspace serialization, guest lifecycle, execution fencing, output capture/replay, logging, and relevant backend retention/admission contracts. This is an implementation review, not a fleet capacity certification. No runtime code was changed.

## Findings

### 1. P1 — Blocked report replay performs quadratic work on the event loop

Source: `packages/relay-daemon/src/terminal-outbox.ts:308`, `:371–377`; replay cadence: `packages/relay-daemon/src/index.ts:807–810`.

For each candidate, `replayBatch` materializes the entire index with `[...this.index]`, then searches for earlier output. A quarantined first record blocks all subsequent records belonging to that command. These skipped candidates do not consume the 50-report attempt budget. Consequently every replay scans all blocked candidates and allocates a full index array for each: O(N²) work, even when there is nothing deliverable. Replay repeats after only 50–100 ms. Non-batched replay also searches the index per blocked report.

An isolated experiment seeded only index metadata, with one quarantined predecessor and all remaining records in the same stream. There was no payload I/O or network traffic:

| Retained records | One replay | Network requests |
| --- | ---: | ---: |
| 1,000 | 18 ms | 0 |
| 3,000 | 140 ms | 0 |
| 6,000 | 521 ms | 0 |

These are local measurements, not production estimates. The synchronous scan delays heartbeats, cancellation, polling, and all other runs sharing the Node event loop. The configured output pressure threshold is 65,536 records, well above the measured sizes.

Recommendation: maintain ordered per-owner queues and a ready-owner ring, skip an entire blocked owner, and bound both candidates examined and elapsed CPU time per replay. Preserve terminal priority and strict ordering within each owner. Owner rotation currently breaks only ties between equal sequence numbers; it does not provide round-robin fairness between streams at different sequence positions.

Validation to add: tens of thousands of records behind one quarantined predecessor, an unrelated interactive stream, and a heartbeat/event-loop-delay assertion.

### 2. P1 — Cancellation cannot interrupt guest boot, and shutdown waits on it

Source: `packages/relay-daemon/src/guest-pool.ts:57–63`, `:118–124`, `:85–89`, `:163–169`; production boot: `packages/relay-daemon/src/sandbox-session.ts:211–290`.

`acquire` checks the signal before selecting a guest, but passes no signal to `lease`. `lease` waits directly on `guest.starting`. Guest startup also receives neither an abort signal nor an outer deadline. If VM creation or workspace preparation stalls, cancelling the run leaves its acquisition pending. It continues holding execution capacity and the workspace gate. `close()` calls `stopGuest`, which waits on the same startup promise, so the stall can also defeat shutdown after the run shutdown grace expires.

Reproduction: hold the pool's injected `start` promise unresolved, call `acquire` with a signal, then abort. Acquisition remained unsettled after 50 ms and only settled when the test explicitly completed boot. Existing tests cover abort while waiting for a free slot, not while booting.

Recommendation: separate cancellation of an individual waiter from ownership of shared boot. Race the waiter against its signal, maintain accurate user counts, bound boot/teardown, and quarantine a slot whose actual VM state is unconfirmed. Do not recycle a slot merely because a JavaScript timeout expired; late startup needs cleanup and exit evidence.

### 3. P2 — Disabled output coalescing exhausts record count with small output

Source: `packages/relay-daemon/src/index.ts:1814–1819`; buffer defaults: `packages/relay-daemon/src/output-event-buffer.ts:19–21`; count quota: `packages/relay-daemon/src/terminal-outbox.ts:147–154`.

The buffer supports holding a timed flush while delivery is busy, and its tests verify that behavior. Production wires `isBusy: () => false`. Thus an outage or slow backend continues creating small durable files every approximately 25 ms under continuous output, even though comments promise larger batches while posting is busy. HTTP report batching combines requests but does not reduce these local durable records.

At approximately 40 records/second/run, five continuously emitting runs can reach 65,536 records in approximately 328 seconds. This is a calculation from the timer and count limit, not measured throughput; scheduling and output cadence affect the actual rate. Tiny batches can trigger storage protection and stop runs far below the default 1 GiB byte quota. Each record also incurs a file flush and directory sync.

Recommendation: make durable-capture aggregation respond to pending writes/replay pressure, with explicit byte and latency bounds. Simply using the live HTTP request flag is insufficient when negotiated batching returns immediately after persistence. Test the actual production wiring during a multi-minute outage.

### 4. P2 — Logging bypasses the output memory and disk bounds

Source: `packages/relay-daemon/src/index.ts:2369–2391`; service-log rotation: `packages/relay-daemon/src/service-log.ts:1–36`.

Every rendered output line is captured in a chained promise until `appendFile` finishes. There is no byte limit or producer backpressure on that chain. Sustained output faster than filesystem writes grows memory independently of the bounded HTTP queue and outbox. Each line is also appended to both the daemon log and its run log. Those files have no size or age retention here; the existing rotation helper covers `service.log` only.

On a long-lived computer, successful delivery removes outbox files but leaves both log copies growing. If logs share the state filesystem, they eventually trigger free-space protection and stop new work. Shutdown additionally waits for the whole logger queue without its own deadline.

Recommendation: use a byte-bounded log writer and explicit overload behavior, rotate the aggregate log, and enforce total retention for completed-run logs. Keep execution evidence in its durable store; diagnostic-log retention must not discard that evidence. Test slow writes and sustained output independently of transport health.

### 5. P3 — Admission tombstones grow for the daemon's whole lifetime

Source: `packages/relay-daemon/src/index.ts:339`, `:1028`, `:1142–1152`.

`admittedExecutions` gains every started command and cancellation target. Nothing removes entries when execution completes and reports are accepted. Memory therefore grows with lifetime command count rather than concurrent work. This is less urgent than replay and logging, but matters for long-running automation computers.

Recommendation: define a durable deduplication retention contract with backend command retention. Retain unresolved executions without a time limit; retire resolved identities only when the backend can no longer redeliver them. An arbitrary in-memory LRU would weaken duplicate-execution protection.

## Consolidation direction

Keep the execution-plane architecture and its existing guarantees: backend dispatch, durable admission before execution, persisted terminal evidence before journal removal, verified report receipts, workspace serialization, and a capacity-bounded guest pool.

The 2,760-line `index.ts` currently owns admission, lifecycle, networking, output orchestration, diagnostics, recovery, and logging. Extract cohesive owners after fixing the concrete defects:

- Run lifecycle: admission identity, lease ownership, cancellation, workspace waiting, exit evidence, and release.
- Report transport: durable capture, pressure, fair replay, acknowledgement, and retry scheduling.
- Runtime lifecycle: guest boot, acquisition, readiness, retirement, and bounded shutdown.
- Diagnostic logging: bounded writes and retention.

Each owner should expose explicit state transitions and resource budgets. Preserve the distinction between execution capacity, workspace waiting, and pending report acknowledgement. Today runs waiting for the same workspace already count against execution capacity; five such runs can consume the default allowance while only one agent executes. Treat a separate bounded waiting queue as a scheduling improvement, with matching backend admission changes.

## Verification and limits

89 focused existing tests passed: guest pool, terminal outbox, report reliability, output buffering, execution watchdog, report storage, and execution journal. Tests were transpiled into `/private/tmp/relay-daemon-review` with the main checkout's installed TypeScript compiler and run using `node --test`. This worktree has no installed `node_modules`; this was not the canonical repository build or a type check. The two isolated experiments used those transpiled source modules. The replay experiment seeded private index metadata to isolate scheduler cost; it did not benchmark persistence or backend ingestion.

No live BoxLite VM, Fly deployment, full backend suite, or fleet load test was run. No production throughput claim follows from this review. Before increasing concurrency, measure event-loop delay, report age and count, capture/write latency, log backlog bytes, VM boot/stop times, and time waiting on workspace gates under steady load, outage/recovery, disk pressure, and restart.
