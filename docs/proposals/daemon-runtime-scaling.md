# Daemon runtime scaling

Status: runtime-specific admission implemented; supervision extraction and resource
scheduling remain planned. No production deployment or throughput claim.

One Computer retains one Daemon Node. Logical Agents retain their Placement,
while independent runs share the Computer's Agent Runtimes. The backend owns the
durable queue; the daemon owns execution and makes the final admission decision.

## Runtime admission

`RELAY_DAEMON_MAX_CONCURRENT_RUNS` bounds all admitted runs on a Computer.
`RELAY_DAEMON_RUNTIME_LIMITS` optionally supplies positive integer limits by
runtime, for example:

```sh
export RELAY_DAEMON_MAX_CONCURRENT_RUNS=6
export RELAY_DAEMON_RUNTIME_LIMITS='{"codex":4,"claude":2}'
```

An omitted runtime inherits the Computer limit. A runtime limit above the
Computer limit is effectively capped by it. Unknown runtime names, malformed JSON,
and non-positive or non-integer values fail daemon startup. Background-service
runtime profiles preserve this setting. Restart the daemon after changing it.

The daemon advertises the effective limits in `executorCapabilities`. Registration
stores each limit in the existing `daemon_node_agents.details` JSON record, under
`maxConcurrentRuns`; no database migration is required. Backend delivery and the
transactional dispatch claim both enforce it. The latter takes the node-row mutex
and counts published runs plus unfinished dispatch claims, deduplicated by Thread.
This prevents two backend replicas from reserving the same remaining capacity.

Runtime saturation leaves an admitted assignment in the bounded backend queue,
without an execution reservation. Other runtimes and independent workspaces can
proceed. The existing Computer queue limit and Task Capacity still apply.

If the daemon's local view differs, it refuses before journaling or starting the
command. A backend advertising the `admission-retry` heartbeat feature receives
`run.failed` with `admissionRejected` equal to `computer-capacity` or
`runtime-capacity`. This is an explicit attestation of non-execution, carried by
the existing durable terminal outbox. The backend closes that command attempt,
keeps the assignment index and Task ownership, and retries with a fresh command
on recovery. A recorded stop takes precedence over retry. Ordinary failures keep
their existing behavior. With an older backend, the daemon retains the legacy
failed-start behavior; deploy the backend first.

Workspace locks remain authoritative. Shared Project workspaces serialize writes;
more run capacity does not enable concurrent edits to one Project directory.
Execution leases, journal reconciliation, and uncertain-exit reservations retain
their existing semantics. Permission prompts continue to occupy execution capacity.
Backend wait logs identify the runtime and distinguish workspace contention from
execution capacity. Admission rejection logs carry the explicit capacity reason.

## Next stages

1. Extract per-run supervision from the daemon entrypoint, preserving its process
   tree cancellation, lease watchdog, journal, workspace gate, and outbox behavior.
   Keep polling, heartbeat, discovery, and output replay independent of each run.
2. Measure queue delay, startup time, active and waiting runs per runtime, memory,
   guest boot/eviction counts, output backlog, and cancellation completion time.
   Define resource budgets from measured workloads before changing defaults.
3. Separate guest capacity from process capacity, account for child processes and
   builds, and add runtime/provider-credential cooldowns with bounded retry.
4. Introduce opt-in isolated Project worktrees only if shared-workspace contention
   limits throughput. That requires an explicit workspace and integration contract
   and a corresponding CONTEXT.md update. Existing Projects keep one workspace.

Do not move Threads between Computers or bypass Placement for load balancing.
Scale independent work across additional Computers using the existing placement
and enrollment model. Persistent runtime services require evidence that CLI startup
cost outweighs their isolation and recovery cost.
