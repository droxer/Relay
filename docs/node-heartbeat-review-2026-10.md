# Node heartbeat and liveness check: design review (2026-10-19)

Companion to [`node-heartbeats.md`](node-heartbeats.md), which states the
contract. This document reviews the implementation as it stood on 2026-10-19
and proposes a revision. Status: findings 1–6, 8, and 9 are implemented and
the contract doc describes the result; the exceptions are noted below. Finding
7 (health in the heartbeat body) is deferred. The `dispatchable` rule shipped
in its softer form — a node that has never polled stays dispatchable — and the
poll freshness window is one maximal poll hold plus the liveness window rather
than the 37 s proposed here, because a poll may legitimately be held its full
wait and then delayed by whatever the heartbeat tolerates.

## What exists today

| Piece | Where | Value |
|---|---|---|
| Liveness timeout | `RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS` | 15 000 ms |
| Advertised beat interval | `heartbeat_settings()` = timeout / 3 | 5 000 ms |
| Durable `lastSeenAt` write throttle | `RELAY_DAEMON_NODE_SEEN_PERSIST_INTERVAL_SECONDS` | 5 s |
| Daemon HTTP request timeout | `REQUEST_TIMEOUT_MS` (`relay-daemon/src/index.ts`) | 30 000 ms |
| Daemon reconnect backoff | `backendReconnectDelayMs` | 1–2 s, 2–4 s, 4–8 s, 5–10 s cap |
| Long poll hold | `DEFAULT_COMMAND_POLL_WAIT_MS` | 25 000 ms |
| Long poll server wake | `COMMAND_NOTIFICATION_RECOVERY_SECONDS` | 5 s |
| Command lease | daemon 90 s, backend default 60 s | |
| Lost-dispatch grace | `LOST_DISPATCH_GRACE_SECONDS` = one lease | 60 s |
| Offline notification confirm | `OFFLINE_CONFIRM_SECONDS` (watcher) | 60 s, process-local |
| Web stale fallback | `STALE_AFTER_MS` (`web/src/lib/adminHelpers.ts`) | 15 000 ms, hardcoded |

Liveness is one derived boolean: `_liveness()` in
`backend/relay/daemon_registry/nodes.py` returns `online` when
`now - lastSeenAt <= timeout` and the status is not `stopped`. `lastSeenAt` is
advanced by `_mark_seen`, which is called from the explicit heartbeat, from
every `take_commands` iteration of the long poll, from lease renewals, run
events, and permission-request polls. The in-memory view is exact per replica;
the durable row is written at most every 5 s. Other replicas learn about a beat
through `_refresh_persisted_liveness`, which merges the durable row back.

The daemon runs the beat as a sequential loop: sleep `intervalMs`, then
`await sendHeartbeat()` under `withBackendReconnect`. A 404 falls back to
re-registration; 401/410 stops the daemon.

## Findings

Ranked by how much they matter.

### 1. Online does not mean deliverable (HIGH)

`online` is renewed by the heartbeat alone. Dispatch admission
(`list_ready` → `node_accepts_run`) only asks for `online` plus capacity. A
daemon whose heartbeat succeeds but whose command poll is failing (a 4xx loop
that re-registers every second, a proxy that rejects the long-poll path, a
poll stuck behind the 30 s request timeout) stays `ready` and keeps receiving
`run.start` commands it never takes. Each one sits until the lost-dispatch
reaper gives up after lease + grace, about two minutes, and only then is the
request recovered to another node.

The contract says "command polls ... do not define liveness", which is right
for liveness, but the backend has no separate notion of "this node is
currently taking commands".

### 2. The timing budget cannot absorb one slow request (HIGH)

Three missed beats expire the lease, but the daemon's beat loop is sequential
and its request timeout is 30 s. One heartbeat that black-holes on the network
holds the loop for 30 s, which alone is twice the liveness timeout. The node
flaps offline, the web shows it stale, the watcher starts its 60 s offline
clock, and any run on it loses its execution lease path even though the
daemon and backend are both healthy.

The reconnect backoff compounds this. After a 502 from an edge proxy during a
backend deploy the retries land at roughly +1.5 s, +4.5 s, +10.5 s, +18 s; the
third retry already overruns the 15 s window. A 15 s timeout with a 5 s beat
is appropriate for a LAN, not for a Cloudflare → Railway path.

### 3. The web hardcodes the timeout the backend owns (MEDIUM)

The backend sends `stale` and `lastSeenAgeMs` on every node, and the contract
says the backend owns the timeout. `isStale` in `adminHelpers.ts` still falls
back to a hardcoded 15 000 ms when `stale` is missing, and
`ThreadRuntimeSelect` reasons about staleness as "a time threshold". Changing
`RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS` would make the admin page and the
backend disagree about which computers are online.

### 4. Cross-replica refresh is a full table read on hot read paths (MEDIUM)

`_refresh_persisted_liveness()` with no node id calls `daemon_store.list_nodes()`
and merges every row under the global `dispatch_lock`. It runs inside
`monitor_nodes`, `list_ready`, `count_user_device_nodes`, and `find_by_user`.
`monitor_nodes` is called from about twenty route sites, several of them more
than once per request (`agent_routes.py` lists nodes per agent). Every web
list of agents, threads, or computers is therefore a full `daemon_nodes` scan
plus a fleet-wide lock. It is invisible at ten nodes and will not be at a
thousand, and it serialises every reader behind the lock the dispatcher needs.

### 5. Three liveness sources renew the same field with different cadence (MEDIUM)

The explicit beat (5 s), the long poll's `_mark_seen` (every 5 s server wake
and every command notification), lease renewals, run events, and
permission-request polls all advance `lastSeenAt`. Each call takes the
per-node dispatch scope and rebuilds the node dict. The design doc presents
the beat as *the* liveness signal; in code it is one of five, and the daemon
pays for two parallel request streams that both carry the active lease list.
Compatibility with older daemons justifies keeping poll-based renewal, but
the sources should be distinguishable (see finding 1).

### 6. Shutdown leaves the node dispatchable while it drains (MEDIUM)

`shutdown()` sets `stopping`, aborts active runs, waits up to the shutdown
grace, and only then posts a `stopped` registration. The beat and poll loops
stop at once, so for up to the liveness timeout the backend still sees the
node online and may deliver a `run.start` that nobody will take (finding 1
again, now on every restart and `relay update`). The stopped notice is also a
full registration payload sent with a short timeout; it is the heaviest
possible message for the smallest possible fact.

### 7. The heartbeat carries no health (LOW)

The body is only the active lease list. The daemon already tracks
`DaemonHealthState`, outbox depth, and guest state, but an admin cannot tell
"alive and wedged" from "alive and idle", and the backend cannot prefer a
node with a drained outbox over one with a backlog.

### 8. Fixed-rate beats with no jitter (LOW)

Every daemon the supervisor launches beats on the same 5 s grid. The managed
fleet will synchronise onto the backend's clock within a few cycles.

### 9. ISO strings compared lexically (LOW)

`_refresh_persisted_liveness` picks the newer of two `lastSeenAt` values with
`max()` on strings. It is correct only while both sides emit the same format
and precision (`now_iso` does). A row backfilled or edited by another tool
with `+00:00` instead of `Z`, or without milliseconds, compares wrongly.
Compare epoch milliseconds through `iso_epoch_ms`, which `_liveness` already
uses.

### What is sound and should stay

- The backend timestamps observations; daemon clocks never extend a lease.
- Durable writes are throttled and never appended to the event log.
- Liveness is derived, never a stored status, so a backend restart cannot
  freeze a node as online.
- Retired identities cannot renew; 401/410 stop the daemon.
- The execution watchdog grants one outage grace only while the backend is
  unreachable, never when it answers without renewing.
- `_refresh_persisted_liveness` keeps the replica that saw the newer beat
  authoritative for status.

## Revised design

### Two observations, two derived facts

Record two timestamps on the node, in memory and in the throttled durable
write:

- `lastHeartbeatAt`: advanced only by `POST /daemon-nodes/{id}/heartbeat` and,
  for compatibility, by any authenticated poll or event from a daemon that
  has never sent an explicit beat.
- `lastPollAt`: advanced only by `take_commands`.

Derive:

- `online`: `now - max(lastHeartbeatAt, lastPollAt) <= timeoutMs`, unchanged in
  meaning so the web, watcher, and admin surfaces keep working.
- `dispatchable`: `online` and `now - lastPollAt <= pollWaitMs + 2 × intervalMs`
  (about 37 s at the proposed defaults), and the node is not draining.

`list_ready` and `node_accepts_run` admit on `dispatchable`. `monitor_nodes`
exposes both plus `lastPollAgeMs`, so the admin page can show "online, not
taking work" as its own state. An older daemon that renews only through polls
has a fresh `lastPollAt` and stays dispatchable.

### Timing budget

| Setting | Today | Proposed | Why |
|---|---|---|---|
| `timeoutMs` | 15 000 | 30 000 | survives one hung request plus two retries |
| `intervalMs` | timeout / 3 | timeout / 5 = 6 000 | four misses before expiry |
| Heartbeat request timeout | 30 000 (shared) | `intervalMs` | a hung beat cannot eat the window |
| Beat scheduling | sequential sleep then send | fixed rate, skip if previous beat is in flight, ±10 % jitter | period stops drifting with latency; herd spreads |
| Reconnect backoff for beats | 1–10 s | cap at `intervalMs` | a beat retry never waits longer than a beat |

The command poll keeps the 30 s request timeout; only the beat gets the short
one. `heartbeat_settings()` continues to be the single source for both values,
and `RELAY_DAEMON_NODE_LIVENESS_TIMEOUT_MS` keeps working with the derived
interval.

### Heartbeat body

```json
{
  "state": "ready" | "draining",
  "activeCommandLeases": [{ "commandId": "...", "leaseId": "..." }],
  "health": {
    "activeRuns": 1,
    "outboxDepth": 0,
    "uptimeMs": 123456,
    "lastPollAgeMs": 1200
  },
  "leaseSeconds": 90
}
```

`state` and `health` are optional so today's daemons remain valid. `draining`
makes the node non-dispatchable at once and is sent as the first act of
`shutdown()`, before runs are aborted. The final `stopped` notice becomes a
second beat with `state: "stopped"` instead of a full registration; the
registration route keeps accepting `status: "stopped"` for older daemons.
`health` is kept in memory on the registry and projected by `monitor_nodes`;
it is never persisted per beat.

### Cross-replica refresh

- `_refresh_persisted_liveness()` with no id runs at most once per
  `node_seen_persist_interval_seconds` per process; callers inside that window
  reuse the in-memory view, which is by construction no staler than the
  durable rows another replica could have written.
- The refresh reads a liveness projection (`id`, `status`, `last_seen_at`,
  `last_poll_at`, `updated_at`, `retired_at`) rather than full rows, and
  merges newer timestamps by epoch milliseconds.
- The per-node variant stays unthrottled; it runs on the hot write paths that
  already hold that node's scope.

### Web

`isStale` stops computing its own threshold. It reads `node.stale` and treats
a missing value as unknown, rendered neutral rather than stale. `threadRuntime`
and `ComputerCard` show the new `dispatchable` fact as "not taking work" when a
node is online but its poll is stale.

### Compatibility

| Daemon | Backend | Behaviour |
|---|---|---|
| old | new | renews through polls; `lastPollAt` fresh; dispatchable |
| new | old | heartbeat 404 → registration fallback, as today |
| new | new | explicit beats carry state and health; shutdown drains |

No wire field is removed. `heartbeat.intervalMs`/`timeoutMs` keep their
meaning; new daemons simply receive different numbers.

## Suggested sequence

1. Backend: record `lastPollAt`, derive `dispatchable`, admit on it, expose
   both in `monitor_nodes`. Tests: a node with fresh beats and a stale poll is
   online and refused dispatch; an old-style daemon stays dispatchable.
2. Daemon: fixed-rate beat scheduler with its own timeout and jitter;
   `draining` and `stopped` beats in `shutdown()`. Tests: a hung beat does not
   delay the next one; a draining beat precedes run aborts.
3. Backend: widen the defaults (30 s / 6 s) and accept `state`/`health`.
4. Backend: throttle and narrow the fleet-wide liveness refresh. Test: two
   `monitor_nodes` calls inside one interval read the store once.
5. Web: drop `STALE_AFTER_MS`, render `dispatchable`.
6. Update `node-heartbeats.md` to describe the two observations and the new
   defaults, then retire this review.

Steps 1 and 2 remove the lost-dispatch window on restarts and the WAN flapping,
which are the two user-visible problems. Steps 3 to 5 are hardening.
