# Node heartbeat leases

Relay treats a heartbeat as a renewable execution-plane lease, not as a side
effect of command polling.

## Contract

1. A daemon registers its identity, capabilities, and agent inventory.
2. The registration response advertises `heartbeat.intervalMs` and
   `heartbeat.timeoutMs`. The backend owns both values.
3. The daemon renews the lease with
   `POST /api/v1/daemon-nodes/{id}/heartbeat`, authenticated by its node token.
4. A renewal may carry active command lease IDs, allowing a busy daemon to
   renew liveness and delivery ownership in one lightweight request, and an
   optional `state` (`ready`, `draining`, `stopped`).
5. Command polls and run events still update `lastSeenAt` for compatibility
   with older daemons, but neither traffic pattern defines liveness.
6. The registration and heartbeat responses also list the backend's heartbeat
   `features`. With `poll-liveness`, an open command poll renews liveness and
   leases on the server, so the daemon skips beats while one is in flight
   (and resumes once the poll has been open longer than its own wait). With
   `state`, the daemon drains and stops through heartbeats instead of a full
   registration. `durable-reports` enables payload-bound acceptance receipts;
   these peers also send independent health probes at the advertised cadence,
   even while a poll is open, to detect a blackholed connection. An older backend
   sends no list and gets the old traffic.

The default policy expires after 30 seconds and renews every fifth of that
(6 seconds), so a daemon may miss four beats. The daemon beats at a fixed rate
with ±10 % jitter, gives each beat its own request timeout of one period (a
request that black-holes cannot eat the window), and never retries inside a
tick: the next tick is the retry. The backend timestamps accepted observations,
so daemon clock skew cannot extend a lease. Durable `lastSeenAt` writes remain
throttled and are not appended to the event log, and the fleet-wide read that
merges other replicas' observations runs at most once per persist interval.

Routine heartbeats read only current credential, lifecycle, and observation
fields. They do not load runtime inventory. A Computer first discovered on
another backend loads its configuration once; command admission continues to
refresh full configuration. Ordinary timestamp writes use a database-time due
predicate shared across replicas, with separate seen/poll clocks. Conditional
writes also check the observed credential/version, lifecycle state, and drain
marker; a skipped write is distinguished from a changed credential or deleted
Computer by a narrow authoritative reread. Local throttling records success
only after storage commits, so failed writes remain eligible for retry.

## Background load

The daemon honors the backend's advertised heartbeat interval (6 seconds by
default), capped at a third of its requested command lease. Durable-report
peers keep those probes independent of long polls. Normal command delivery
wakes a poll through notifications; a missed notification is recovered within
6 seconds with a connected bridge, or 2 seconds otherwise. Short leases and
liveness windows further shorten those waits. Idle polls do not perform a
separate lease-renewal lookup.

Command leases are durably extended when at most two thirds of the requested
duration remains. The database predicate shares this throttle across backend
replicas. The first explicit delivery acknowledgement is always persisted
immediately. Due extensions are batched, update only the lease timestamps,
and do not append routine renewal events; command delivery and terminal
transitions retain their events. Lease responses report the actual persisted
expiry, so execution watchdogs never assume an extension that did not happen.

Transport diagnostics are still sampled locally every second. The daemon sends
health transitions immediately, coalesces activity changes to at most one report
per 5 seconds, and refreshes an unchanged healthy snapshot every 30 seconds.
Unresolved incidents refresh every 5 seconds to preserve recovery/progress
observations. Failed deliveries back off from 5 seconds to a maximum of 60
seconds, honor `Retry-After`, and warn at most once per 30 seconds. A successful
upload resets the backoff. Sampling and heartbeat probes continue independently.
Transport errors include nested DNS/TLS/socket codes when available, without
logging request headers or cause payloads.

## Alive is not listening

Command handling runs beside polling. Run starts retain their execution capacity
limit, and cancellations signal active runs immediately. Workspace commands and
cancellation/rejected-run reports use a background queue with at most 32 admitted
tasks and four active senders. Requests for the same workspace remain ordered;
other workspaces can progress independently. Duplicate pending command/lease
pairs share their task. Polls and heartbeats renew queued workspace and runtime
refresh leases alongside active run leases, within the wire's 50-lease bound.

Runtime refreshes, including explicit refresh requests, probe in the background.
An idle BoxLite Computer can boot a guest for the refresh while continuing to
poll; new runs are deferred while the guest is unavailable. Shutdown aborts
network work, drops queued workspace requests for lease redelivery, and settles
active background tasks. Run outcomes enter the durable outbox before queue
admission; workspace replies continue to rely on command redelivery after a
restart. Filesystem helpers retain their existing synchronous validation and I/O;
this scheduling change removes network retry and probe waits from polling.

`online` says the daemon is alive. `dispatchable` says it will take work:
online, and its last command poll (`lastPollAt`, advanced only by
`take_commands`) is younger than one maximal poll hold plus the liveness
window. A node that has never polled keeps the benefit of the doubt, because
its first poll follows registration within a second. A registration never
clears the observation, so a daemon stuck re-registering after each failed
poll stays non-dispatchable. Dispatch admission (`list_ready`,
`_placement_admits_run`, task placement) requires `dispatchable`; the web and
the notification watcher keep reading `online`.

A `draining` heartbeat pins the poll observation to the epoch, which no
replica can read as fresh, and is written to the durable row at once. The
daemon sends it as the first act of shutdown, before aborting its runs, so
nothing is dispatched into the drain and lost; it ends with a `stopped`
heartbeat where the backend understands `state`, else the `stopped`
registration. The drain is sticky: a command poll that still reaches the
backend from a drained node (the long poll the daemon hung up on keeps
running server-side until its deadline) leases nothing and does not count as
a poll, and the poll handler stops early once it sees the client is gone.
Only a registration lifts the drain, because a registering daemon is a new
incarnation that is about to poll; it starts with no poll observation, like
a brand-new node.

Poll observations are persisted on their own clock, separate from the
throttle on plain liveness writes. The long poll renews leases (a plain
observation) just before it takes commands (the poll observation), so one
shared clock let the plain write win every time and `lastPollAt` never
reached the row for an idle daemon — invisible on one replica, which reads
its memory, and a false "not listening" on any other.

## Local and managed nodes

User-device and managed nodes use the same heartbeat interface and timeout
semantics. Their behavior differs only after expiry:

- A user-device node becomes offline and remains assigned. Waking or
  restarting its daemon renews the same identity when its credential is still
  valid.
- A managed node becomes offline, then the managed-node reconciler applies its
  recovery grace period and may retire and replace the runtime/provider
  instance. Heartbeats themselves never provision infrastructure.

This keeps liveness detection in one module while leaving recovery policy with
the owner that has authority to act.

## Failure and compatibility rules

- Missing renewals make a node offline; they do not immediately delete its
  identity or placements.
- Retired identities cannot renew their lease.
- A daemon that receives `404` from the heartbeat endpoint falls back to a
  registration refresh, supporting rolling upgrades from older backends.
- Registration refresh remains separate and slower because capability and
  inventory discovery are materially more expensive than liveness renewal.
- A graceful shutdown drains, then reports `stopped`; an ungraceful exit is
  detected by lease expiry.
- A beat refused with any other 4xx is logged and tried again next tick; only
  401/410 stop the daemon — and only from registration, the heartbeat, and
  the command poll. An event the backend refuses because it names a command,
  lease, or run the node does not hold answers `409`, never `401`: the
  credential is fine, and a daemon must not stop over one run's report.

## Command notification recovery

Command polls wake on committed queue notifications. With a PostgreSQL bridge
that has completed `LISTEN`, an idle poll re-reads the queue every six
seconds as a recovery path for missed notifications. SQLite and disconnected
bridges use a two-second bound. Notifications wake polls immediately.

The wait is also capped at one third of the requested command lease and one
fifth of the node liveness timeout, so longer recovery waits do not delay lease
renewal or cause an idle node to appear offline. These intervals bound recovery
reads rather than guaranteed end-to-end dispatch latency under load.

Cancellation acknowledgements for runs that are not executing, and failure
reports for rejected starts, are durably retained directly from the command
loop. Their HTTP delivery runs in bounded background tasks and the independent
outbox replay worker. An unavailable
event-ingestion endpoint therefore cannot stop command polling while independent
heartbeats continue to advertise liveness. A capture failure activates storage
protection and remains visible without crashing the poll loop.

Output batches are retained before sending and live output cannot pass an
unacknowledged earlier sequence for the same command lease. Replay sends the
pending sequences in order. Concurrent live/replay copies may arrive late, but
only after a successful copy allowed the next sequence to proceed; backend
per-stream high-water deduplication then suppresses those duplicates. A failed
output upload does not prevent terminal evidence from releasing the run;
retained output can be replayed after completion.

## Repeated HTTP/2 stream failures

The daemon and `relay doctor` use a dedicated dispatcher that prefers HTTP/2
when the server negotiates it. Each HTTP/2 transport failure before response
headers retires that origin's connection pool, so the next attempt gets a fresh
connection. Three failed pools within five minutes switch that origin to HTTP/1.1 until
the daemon restarts. Successful heartbeats between failed uploads do not erase
the failure history; failures age out after five minutes. Ordinary HTTP errors,
DNS failures, and caller cancellations do not trigger a downgrade.
Late results from retired pools cannot change the replacement pool's failure
count. In-flight requests can finish under their existing deadlines; this layer
never replays a failed POST, since callers and the durable outbox own retries.

Undici 8 (bundled with Node 26) [enables HTTP/2 by default][undici-h2-default];
older daemon builds inherit the host runtime's global `fetch` behavior and have
no explicit pool recovery or protocol fallback. The new dispatcher honors
`HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` (and their lowercase forms), keeps TLS
certificate verification, and does not change the process-wide dispatcher.
Caller-supplied `fetchFn` implementations retain their own transport policy.

`fetch failed; ERR_HTTP2_STREAM_ERROR` means a stream reset, not an HTTP status
or credential rejection. Retrying the same HTTP/2 path cannot repair a peer that
consistently resets streams. A local TLS regression test reproduces that failure
with an HTTP/2-resetting peer that successfully serves HTTP/1.1. This demonstrates
the compatibility failure, but does not identify which proxy or server caused a
particular production incident.

`Transport recovery probe superseded a stalled poll` is a separate, locally
generated cancellation: after a transient failure, the daemon aborts an outstanding
poll. It does not indicate that a new connection or protocol was selected.
Errors retain the numeric `http2ErrorCode` when Node supplies one and the known
`http2Reset` name when a wrapper preserves only the message. Pool replacement and
HTTP/1.1 fallback each log the origin, path (without query), method, request
size when known, elapsed time, failure count, and error detail. Arbitrary
nested error messages and response payloads are not logged.

A captured `http2Reset=NGHTTP2_ENHANCE_YOUR_CALM` identifies a peer protection
limit, not lack of HTTP/2 support or credential rejection. It does not identify
the exact frame or rate threshold. [Cloudflare's HTTP/2 guidance][cf-h2-calm]
explains that legitimate client frame patterns can trigger these protections.
Correlate the failing operation and timing with upstream logs before attributing
it to request volume, cancellations, header size, or keepalive frames.

For an older installed daemon exhibiting this pattern, capture its Node version,
`relay doctor` output, and backend hostname. After deploying a bundle containing
this transport change, update the affected computer with `relay update`. Updating
only the backend does not replace an already-running daemon. Preserve the private
report storage so pending evidence can replay after connectivity returns.

[cf-h2-calm]: https://blog.cloudflare.com/go-and-enhance-your-calm/

[undici-h2-default]: https://github.com/nodejs/undici/blob/main/docs/docs/best-practices/migrating-from-v7-to-v8.md

## Durable report transport

Apply migrations through `20261110_0123` before deploying this backend. Updated daemons
advertise `durable-reports`; the backend advertises the matching feature plus
`report-batches` and `transport-status`. Existing HTTP routes and long polling
remain the transport. Legacy peers continue working, but diagnostics mark their
durability guarantee as unverified.

Output is written to private report storage asynchronously, flushed, renamed,
and directory-synced before transmission. Terminal evidence is written
synchronously before its execution journal entry is cleared. Captures whose
flush has not completed are explicitly outside the crash-survival boundary.
Successful uploads remove records only after the backend returns a receipt
binding the report identity and payload digest. The receipt and effects commit
in one database transaction. Lost replies can therefore be retried safely on
another backend replica, including after command history is pruned or a thread
is deleted. These small node/identity/digest receipts are retained independently
of that history; a retry acknowledges the original acceptance without applying
the report again. Sequenced output cannot skip a missing predecessor; terminal
evidence and unrelated runs can still progress.
Terminal acceptance commits the command's exit evidence and receipt together;
workflow finalization then uses its own transactions. A finalization failure
leaves the committed evidence available for the existing recovery loop, rather
than retaining locks across unrelated Computers.

Transient failures retry indefinitely with jitter, bounded request deadlines,
and `Retry-After`. Permanent report rejections are quarantined with their bytes
and reason intact. Only malformed input is a 400: unexpected processing
exceptions, including `ValueError`, `TypeError`, and `KeyError` after validation,
roll back their batch group and return a retryable 500. A thread missing when
acquiring its mutation lock is a terminal 409 instead: an unaccepted report
cannot be applied to deleted history. Its bytes remain quarantined, and no
acceptance receipt or execution-exit evidence is fabricated. Previously accepted
reports still replay from their durable receipts. Unrelated groups can
still commit. Batch rejection receipts include a bounded reason, without
returning internal exception details.

New quarantine markers retain the original HTTP status, bounded rejection
detail, and timestamp across daemon restarts. `relay reports` displays that
reason and the Computer-specific recovery command. Historical status-only
markers remain quarantined and explicitly say their reason was not recorded.
A redelivered cancellation whose terminal report is quarantined neither
resubmits it nor repeatedly logs that it will retry; polling continues, with
the normal idle throttle when the batch contains only quarantined stops.
The initial live rejection says automatic retries are paused, rather than
promising recovery that cannot happen automatically.

One terminal-report exception handles the backend's explicit
identity/owner/payload receipt conflict: the daemon retries the exact retained
payload under a deterministic ID derived from its local report ID and payload
digest, preserving the original receipt. A batch 409 is checked individually
for that exact conflict before retrying. The retry requires matching report-ID
and digest receipt headers even without durable-report negotiation; missing or
mismatched proof keeps the report pending. Unknown-command and command-ownership
rejections still quarantine the report. This recovery does not automatically
unquarantine reports already retained for intervention.
Contact loss alone neither reruns nor kills an active agent.
An unacknowledged start may be redelivered with its original command and lease;
the daemon's execution journal fences unresolved admission. A compact private
`admissions/` ledger also preserves command hashes after completion and across
restarts. Its hot cache is bounded to 4,096 identities; evicting a cache entry
never removes its durable fence. Each identity uses a 32-byte SHA-256 record,
partitioned across 4,096 shard files. Backups include this ledger along with
`executions/` and `terminal-events/`. An uncertain process
exit keeps the execution reservation until observed exit or a recorded human
assertion.

The report budget defaults to 1 GiB (`RELAY_DAEMON_REPORT_STORAGE_BYTES`).
Admission stops at 80%; at 90%, running agents receive a graceful stop, followed
by forced termination after ten seconds. Shutdown output can use the reserve up
to 97%, leaving the final 3% for terminal evidence. A capture that exhausts that
reserve or fails to flush records a persistent fault rather than claiming
complete output. Physical free-space thresholds independently stop admission
below 256 MiB and active runs below 128 MiB. Recovery requires less than 50%
of the budget, at least 512 MiB free, a usable backend, and no persistence fault.
Override those physical thresholds with
`RELAY_DAEMON_REPORT_FREE_ADMISSION_BYTES`, `RELAY_DAEMON_REPORT_FREE_STOP_BYTES`,
and `RELAY_DAEMON_REPORT_FREE_RESUME_BYTES` (stop < admission < resume).

The daemon supervises its heartbeat and report-replay loops. Expected transport
failures follow their retry policy. An unexpected loop exit logs a failure and
drains the daemon, closing admission and requesting execution shutdown; it cannot
leave the Computer accepting new work with no heartbeat or replay loop. A fatal
poll/re-registration failure also drains before returning its error. Pending
reports remain on disk for the next start. Cancelling a retry during shutdown
does not change an already durable terminal outcome.

`relay status`, `relay doctor`, and `relay reports` expose local diagnostics.
Stop the daemon before `relay retry-report --report <id>` or
`relay discard-report --report <id> --acknowledge-output-loss`; both record the
local operator in a private audit record. Discard is deliberate loss and never
counts as acceptance. Back up the private daemon state when moving a Computer;
deleting its report directory destroys its only unaccepted evidence.

A stop acknowledgement for an already completed or failed run settles the stop
without changing the run's outcome. Retention keeps a target command while its
stop is unacknowledged. For older orphaned stops whose targets were already
pruned, a durable cancellation acknowledgement can instead use the retained
stop's matching Computer, command, Thread, run, runtime, and lease as authority.
The stop completion and payload-bound receipt commit together, even if the
Thread was deleted. Other unknown reports still receive 409. After upgrading
the backend, stop the daemon, retry the affected cancellation reports with
`relay retry-report --report <id>`, and start it again; quarantined reports are
never retried automatically.

An outage lasting 60 seconds, or an immediate storage, credential, quarantine,
or uncertain-exit fault, opens one incident per stable Computer. The owner (or
shared-hardware admins) receives a concise notice with a protected diagnostics
link. Updates and recovery preserve the notice's read/cleared state. Recovery
requires ten seconds of healthy contact and replay progress. Local incident
state survives network loss and daemon restart.

Run the disposable PostgreSQL transport probe with:

```sh
PYTHONPATH=backend python backend/tests/benchmarks/daemon_transport.py \
  --database-url postgresql+psycopg://localhost/relay_probe \
  --replicas 2 --daemons 100 --warmup 120 --duration 600 \
  --output /tmp/relay-transport.json
```

The tool refuses non-loopback backends, creates and drops an isolated schema,
and uses real daemons with synthetic agent output. `--fault blackhole`,
`ack-loss`, `duplicates`, or `server-error` injects one episode. Repeat at least
20 recovery episodes; platform reboot, storage-device faults, reference CPU
allocation, and sustained load require separate acceptance evidence. A short
smoke result does not establish the reference SLO.

### Restart exit evidence

A wall-clock boot-time estimate is historical metadata, not proof of reboot or
process exit. A restarted local daemon confirms that the recorded process group
is absent; a Windows daemon requires a process list showing no remaining tree
members. Missing or inconclusive evidence continues to require reconciliation.
Windows tree cleanup distinguishes a reused root PID from its older orphans:
children created after the replacement root are excluded, while older orphans
and their descendants remain part of the recorded run.

Process-operation errors after spawn (including a denied termination signal)
are not exit evidence. The local supervisor reports unconfirmed exit, retries
termination, and holds execution until cleanup is verified or a person reports
it gone. On Windows, unavailable process enumeration likewise keeps the run
reserved even after the root's pipes close; enumeration errors are terminating
PowerShell failures rather than an apparently empty successful process list.


## Daemon resource bounds

Replay maintains ordered queues per command lease. Each turn selects at most
50 reports and examines at most 200 output owners and 200 terminal records.
Quarantined heads block their own stream without repeatedly scanning its tail;
terminal evidence keeps priority and output owners rotate across turns, even
when their requests fail.

Output normally flushes after 25 ms. While earlier output is unacknowledged,
the daemon coalesces small chunks for at most one second, still flushing at
256 Ki characters or 1,024 entries. In-memory chunks and writes that have not
finished flushing remain outside the crash-survival boundary.

A guest boot has a 60-second deadline. Cancelling a waiter releases the run
promptly without cancelling another borrower's boot. A timed-out boot retains
its slot until late startup and cleanup prove it stopped; failed teardown never
frees a slot. Pool shutdown and native runtime shutdown each have a 10-second
waiting deadline. Expiring a deadline does not assert that a guest exited.

Diagnostic logs use a queue bounded to 4 MiB and 4,096 entries. Under pressure,
diagnostic records can be omitted with a throttled warning; durable reports use
a separate path. The aggregate daemon log keeps two generations of at most
10 MiB each. Run logs are capped at 10 MiB per file, 100 MiB total, and 1,000
files, including cleanup of older logs at startup. Diagnostic-log shutdown
waits at most one second. Service-manager log rotation remains separate.
