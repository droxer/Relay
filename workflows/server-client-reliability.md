# Backend ↔ Relay daemon reliability workflow

Status: confirmed and complete. The user accepted Q1–Q16 and confirmed the
consolidated operational and verification defaults in Q17. This file is the
workflow source of truth; implementation, deployment, and live fault injection
are outside this specification session.

## Outcome and scope

Continuously maintain reliable, low-latency communication between the Python
backend and each Relay daemon (Daemon Node). Detect interruptions, recover
safely, replay pending reports, and involve a person only when needed.

The user confirmed the runtime recovery loop, rather than a recurring engineering
audit. Browser transport and Agent Runtime performance are outside scope; Relay
notifications and diagnostics are included as the incident-reporting surface.

Start by hardening authenticated HTTP command long polling, event uploads, and
heartbeats. A replacement transport requires measurements demonstrating that the
agreed targets cannot be met. The backend remains a control plane and never runs
agents. Personal and managed Computers follow the same transport contract;
provider replacement authority remains with existing managed-Computer policy.

## Confirmed requirements

- Continue active agent runs through temporary transport outages.
- Retain pending output and completion/failure reports durably before sending;
  replay until the backend acknowledges durable acceptance. Retained reports
  survive daemon crashes/restarts and Computer reboots with local storage intact.
- Lost contact never, by itself, releases an execution reservation or causes a
  duplicate run. After restart, inspect durable records and process/exit evidence;
  if execution remains ambiguous, keep it reserved and prepare human reconciliation.
- Healthy command delivery: p95 ≤ 1 second from durable queue commit to daemon
  receipt. Healthy output delivery: p95 ≤ 1 second from capture to durable backend
  acceptance. Agent startup, model response, and browser rendering are excluded.
- Temporary-outage recovery: p95 ≤ 5 seconds from the backend becoming reachable
  and accepting authenticated requests to successful command polling and the first
  pending-report replay acknowledgement, when reports are pending. No manual
  restart is needed while the daemon runs with valid credentials and usable state.
  This target does not require an entire backlog to drain within 5 seconds.
- Retry transient failures indefinitely with bounded request times and jittered
  backoff. Never expire unacknowledged reports solely because of age.
- Preserve pending reports before continuing execution when storage is pressured.
  Default shared budget per daemon is configurable and equals 1 GiB: stop new
  admission at 80%; safely stop affected active runs at 90%; reserve the final
  10% for shutdown/final reports. Resume admission only below 50% after recovery.
- Permanently rejected reports enter quarantine with their identifiers and reason.
  Stop automatically retrying those reports, preserve them within the same budget,
  and continue unrelated traffic. Do not claim delivery or silently skip a missing
  sequence within the affected run.
- Stop/cancel commands, heartbeats, and completion/failure reports take priority
  over output replay. Preserve per-run output order. Terminal evidence can arrive
  before remaining output; late output must remain admissible afterward.
- Offline stop requests remain pending; neither delivery nor receipt alone proves
  that a process stopped. Use exit evidence or recorded human reconciliation.
- Escalate after 60 seconds of continuous communication failure, or immediately
  on rejected credentials or storage protection. Maintain one incident brief per
  Computer, updated through recovery instead of notifying on every retry.
- The brief identifies affected runs, retained reports, recovery attempts, required
  action, and a link to diagnostics.
- Initial synthetic acceptance load: 100 connected daemons, up to 3 active runs
  each, 10 KiB/s output per run, and 100 ms network RTT. No paid model calls.
- Automated fault coverage includes dropped requests/acknowledgements, duplicates,
  backend/daemon restarts, Computer reboot, missed command notifications, storage
  pressure, credential rejection, and cancellation during an outage. Require no
  retry-caused duplicate execution, no lost durably retained reports, no false
  completion, and recovery or an actionable incident.

## Confirmed operational defaults

These defaults make the workflow implementable. Internal module structure and
algorithms may vary if they satisfy this contract and the repository invariants.

### Trigger, state, and normal operation

Start the loop when the daemon starts, restoring its private execution journal,
report queue, quarantine, and incident record before admitting new execution.
Run until explicit daemon shutdown or node-wide credential revocation. Inputs
are queued commands, captured run reports, heartbeat deadlines, transport results,
and storage changes. Use timers for deadlines and retry eligibility; no AI or
human checkpoint is needed for normal recovery.

Track transport state separately from execution and report-delivery state:
connecting, healthy, retrying, and revoked. Track backlog, quarantine, and storage
protection independently; a successful heartbeat does not mean output is delivered
or command polling is functioning. Keep the existing online/dispatchable distinction
and backend-owned liveness policy (currently a 30-second default expiry).

Healthy latency samples require valid credentials, a dispatchable daemon, storage
below admission limits, and functioning transport. Commands must be eligible for
immediate delivery. Report scheduled/capacity waits separately rather than hiding
them as network delay. Output-stream latency samples require no prior backlog or
quarantined gap in that stream. Control responsiveness is tested during replay too.

When reconnecting, reconcile execution ownership and pending cancellations before
starting newly delivered work. Recovered communication permits admission only if
storage and execution ownership checks also permit it. Runs stopped by protection
are not automatically restarted by this transport workflow; existing application
policy or an explicit user action owns subsequent execution.

### Durable identity, acceptance, and ordering

Give each execution a stable command/run identity and ownership fence, persisted
before launching the process. Redelivery and lost acknowledgements must not launch
that identity twice, including after backend or daemon restart. Reject stale owners
without revoking the Computer's valid credential. Ambiguous launch/exit evidence
uses the confirmed reconciliation path, never a speculative rerun.

Persist each report with stable identity, payload, command/run ownership, and output
sequence before its first transmission. Durable means file contents and required
filesystem metadata are synchronized; an asynchronous write merely scheduled in
memory is insufficient. The persistence operation must finish before its producer
is told the report is safely retained. The survival guarantee begins at that durable
boundary; an abrupt crash can interrupt a capture before persistence completes.
Never describe such an unproven tail as a complete transcript.

The backend atomically commits report effects and deduplication state before
acknowledging acceptance. A duplicate with identical identity/payload returns proof
of prior durable acceptance; a conflicting payload is an explicit conflict. Delete
local report data only after verifying acceptance for that identity. Lost responses
cause replay with the same identity. Restart must tolerate interrupted writes and
acknowledged files whose local cleanup did not finish.

Deliver contiguous output sequences per command ownership fence. Do not use a
high-water mark to silently accept missing predecessors. Duplicates have no second
observable effect. A terminal event is logically independent of transcript completion:
release execution only on valid exit evidence, preserve unfinished output delivery,
and accept its authorized replay after terminal status. Unrelated streams continue
when one has a quarantined gap. No global ordering across Computers is required.

### Failure classification and retry

Network errors, request deadlines, HTTP 408/429, and 5xx are transient. Respect
Retry-After. Treat a throttled or failing endpoint as not yet usable for the recovery
measurement. Bound concurrent recovery work per daemon; retries must not grow an
unbounded in-memory queue or synchronize the entire fleet.

Choose explicit request deadlines, reconnect probes, and jittered delays that
satisfy the 5-second recovery target, including black-holed connections. Do not
wait for an old long poll or output request's full timeout before probing recovery;
use an independently bounded control path and replace stale in-flight operations.
Healthy long polls can retain their intentional server hold without being counted
as transport latency. Record all chosen timing values in the implementation's
configuration and measurement artifact; no user decision about a specific retry
algorithm is required.

Registration, heartbeat, or command-poll 401/410 follows the existing revocation
shutdown contract: stop admission, terminate controlled runs through normal shutdown,
retain evidence/reports, and require explicit setup to regain authorization. Never
rotate credentials, change identity, or reenroll automatically. A run-scoped report
rejection must not be interpreted as node-wide revocation. Preserve documented
rolling-upgrade fallbacks, including heartbeat 404 handling; do not classify every
4xx as permanent before applying endpoint-specific protocol rules.

A permanently rejected report opens or updates an incident and stays quarantined.
Unrelated output and control traffic continue. A person may authorize retry after
correcting the cause; removal without delivery requires an explicit, recorded
report-discard action naming the affected identities and acknowledging transcript
loss. Never treat removal as backend acceptance. Credential repair does not silently
transfer a queue to a different Computer identity.

### Storage safeguards

The 1 GiB budget includes serialized pending/quarantined reports and their queue
metadata; account for temporary writes and reserved in-flight bytes before admitting
more data. Store these files outside agent workspaces with private directory/file
permissions. Bound batching and concurrency, and apply backpressure to output capture
when durable storage cannot keep up.

Use the confirmed 80%/90%/50% thresholds. At 90%, every active run producing reports
into that protected queue is affected. Stop new admission first, request graceful
termination, and use a 10-second grace before escalating through the existing process
supervisor. Continue collecting bounded shutdown output within the reserved space.
Never assert exit if termination cannot be verified; fence the run and escalate.

Independently guard actual filesystem free space: below 256 MiB stop admission;
below 128 MiB activate active-run protection. Resume only with at least 512 MiB free,
usage below 50%, backend recovery, and no persistence fault. These are configurable
defaults. Unexpected write failure or corruption immediately activates protection
regardless of percentages. Preserve every readable committed record, record the
failed write and affected stream if possible, and explicitly mark unproven output
as incomplete. Do not promise durability on a failed/full filesystem.

Reserve capacity before each capture batch and cap outstanding capture buffers so
shutdown cannot consume the report quota without detection. If an uncooperative
producer exhausts the reserve, terminate/fence it and surface incomplete capture;
never evict earlier retained reports to hide the failure. Verify this adverse path.
Quarantine has no automatic age expiry; the explicit discard path above is its
escape route when repair cannot make a report deliverable.

### Incident brief and human checkpoint

Begin an outage episode at the first failed request or missed expected control-path
deadline; idle agent output is not evidence of failure. Backend-side liveness and
poll observations can detect a missing daemon independently. Require 60 continuous
seconds before an ordinary communication incident. Revocation, persistence failure,
quarantined reports, and storage protection escalate immediately.

Persist one open incident aggregate per stable Computer, with a set of causes so
network recovery cannot clear an unresolved storage/rejection problem. Reconcile
local and backend observations into that incident. Route to its owning User; shared
unassigned administrative hardware routes to admins under existing notification
rules. Each recipient sees only authorized run metadata and diagnostics.

If the backend is unavailable, retain the local incident for inspection through
Relay's local status/diagnostic tooling. Do not promise delivery through the failed
channel. The backend can create its own brief from missed observations while it is
available. Merge the local evidence on reconnect and update the existing notification
without a new unread notice on each retry. No email/Slack/other channel is added.

The brief states the Computer, start/last-observed times, current causes, affected
run IDs, last acknowledged output positions, pending/quarantined bytes, recovery
attempt summary, next automatic action, and any decision needed, with an authorized
diagnostics link. It never embeds raw output, secrets, or credentials.

Normal transport recovery is automatic. Ask a person only to repair rejected
credentials/storage, handle quarantine, or reconcile ambiguous execution. Gather
available evidence and prepare the specific repair/retry/reconcile action first.
Use the existing recorded reconciliation authority; never imply a human assertion
was an observed process exit. Record actor and affected identities for interventions.

Mark a communication cause recovered after 10 seconds of successful polling and
report delivery progress (or no pending reports). Keep backlog visibly catching up;
keep other causes open. A later failure after resolution starts a new episode.

### Compatibility and ownership

Preserve token privacy, per-User/Computer authorization, lease fencing, public wire
compatibility, and deleted-Computer tombstones. New durable-acceptance semantics
must be capability/version negotiated. Mixed-version pairs retain their documented
legacy behavior and are visibly identified as not satisfying this full contract;
never silently certify an older pair. Test backend-first and daemon-first upgrades.

Python owns backend acceptance, deduplication, dispatch, and incident persistence.
TypeScript owns daemon capture, durable local reports, retry, and process control.
Only notification/diagnostic views are a frontend change; general browser transport
and managed infrastructure recovery remain outside this workflow.

## Confirmed verification defaults

### Reproducible load and latency

Use disposable local test resources and synthetic Agent Runtime processes. Do not
inject faults into a live deployment or run paid model/provider jobs.

Run PostgreSQL-backed healthy-load tests against both one backend replica and two
replicas sharing the database and notification bridge. Reference allocation: 8 vCPU
and 16 GiB RAM total for the backend (split evenly with two replicas), 4 vCPU/8 GiB
for PostgreSQL, and 8 vCPU/16 GiB for load generation, on SSD storage. Record actual
CPU model, platform, storage, versions, configuration, network emulator, and source
revision. Equivalent local allocation is acceptable if reported; resource shortages
are an explicit unverified capacity result, never a pass.

Use 100 isolated daemon state directories, 3 synthetic runs per daemon, 1 KiB output
chunks every 100 ms per run, staggered 10-second runs, 100 ms RTT, no injected packet
loss, and at least 100 Mbit/s available bandwidth per test host. Warm up for 2 minutes,
then sample for at least 10 minutes and until at least 10,000 command deliveries
and 10,000 output reports have been measured per topology.

Correlate stable report/command IDs at durable commit and receipt boundaries. Use
synchronized endpoint clocks with verified ≤ 5 ms skew, or a harness proving an
equivalent common monotonic time base. Report uncertainty conservatively. Publish
sample counts, p50/p95/p99, maximum, failure rates, and per-daemon distributions.
Do not drop timeout/failure samples from the denominator; an undelivered item is a
latency miss. Command and output p95 must each be ≤ 1 second in both topologies.
Do not claim these measurements include agent/model/browser delay.

### Fault matrix and recovery

Exercise request drops, response/acknowledgement loss after commit, duplicates,
connection black holes, 408/429/5xx, backend restart, daemon termination/restart,
disposable-Computer reboot, missed PostgreSQL notifications/bridge disconnect,
storage thresholds, physical disk-full/write failure, corruption, credential
revocation, report conflicts, and offline cancellation.

Use 1-, 30-, and 300-second network outages. For recovery timing, include at least
20 independently timed outage/restore cycles at the 100-daemon load for each of
request black holes, backend restart, and temporary 5xx. Measure from restoration
of usable service to the later of successful command polling and first pending
report acknowledgement for each daemon. Include all daemons; failures are misses.
Require p95 ≤ 5 seconds for each fault class, including long-outage capped-backoff
recovery. Reboot/restart tests separately measure startup; the 5-second live-daemon
target does not assert a boot-time guarantee.

For every fault verify exactly one launch per execution identity, deduplicated
backend effects, contiguous output reconstruction for all durably retained reports,
terminal evidence independent of backlog, accurate pending cancellation, and no
reservation release on silence. After recovery require backlog progress without
starving control traffic. With all synthetic runs finished and 100 Mbit/s bandwidth
available, require a 10 MiB backlog per daemon to drain within 120 seconds; quarantine
is excluded from drain completion only when explicitly reported as rejected.

Use subprocess crash barriers before/after report sync, launch journaling, backend
commit, and local acknowledgement cleanup. A crash before the durable capture
boundary is explicitly classified as an unproven capture tail, not a successful
durability test. Corrupt records must not prevent discovery of other readable reports.
Use a disposable VM reboot to verify disk recovery; a process restart alone is not
proof of reboot durability.

Assert storage thresholds and reserve behavior, bounded memory, graceful-to-forced
stop escalation, incident deduplication/routing, and authorization of brief links.
Exercise each supported daemon OS's native persistence/process-control path with
focused integration tests; use the full load matrix on Linux. Run protocol coverage
on SQLite too; PostgreSQL replica/notification results cannot be inferred from SQLite.

The acceptance artifact contains measurements, exact commands, environment manifest,
fault seeds/timings, retained-versus-accepted identity reconciliation, test results,
and remaining limitations. No reliability or latency claim is accepted without this
evidence. These are implementation acceptance requirements, not tests run in this
specification session.

## Existing evidence and implementation ownership

- `../docs/CODEX-NAVIGATION-GUIDE.md`: ownership and transport lifecycle.
- `../CONTEXT.md`: Computer, Daemon Node, Agent Runtime, Notification vocabulary.
- `../docs/guides/node-heartbeats.md`: liveness, polling, replay, and revocation.
- `../packages/relay-daemon/src/index.ts`: daemon loop, retries, report sending.
- `../packages/relay-daemon/src/terminal-outbox.ts`: private report storage/replay.
- `../backend/relay/daemon_registry/`: admission, delivery, ownership, finalization.
- `../backend/relay/api/computers/`: daemon wire boundary.
- `../backend/relay/notifications/`: recipient rules and Computer observations.

Observed gaps in the current daemon: output uses write-behind persistence without
waiting before live transmission; permanent 4xx rejection clears retained records;
the output-only default budget is 64 MiB; reconnect/event retry delays can reach
10 seconds, with a general 30-second request timeout. These observations motivate
work but are not benchmark results or an exhaustive implementation audit.

## Confirmation

The user confirmed the consolidated specification in Q17, including its operational
and verification defaults. No specification decisions remain open. This confirmation
accepts the workflow specification; implementation and live external actions remain
outside this session's requested scope. Acceptance tests described above have not
been run during this specification session.
