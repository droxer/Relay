# Node heartbeat leases

> The review that led to the current shape is
> [`node-heartbeat-review-2026-10.md`](node-heartbeat-review-2026-10.md).

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
   registration. An older backend sends no list and gets the old traffic.

The default policy expires after 30 seconds and renews every fifth of that
(6 seconds), so a daemon may miss four beats. The daemon beats at a fixed rate
with ±10 % jitter, gives each beat its own request timeout of one period (a
request that black-holes cannot eat the window), and never retries inside a
tick: the next tick is the retry. The backend timestamps accepted observations,
so daemon clock skew cannot extend a lease. Durable `lastSeenAt` writes remain
throttled and are not appended to the event log, and the fleet-wide read that
merges other replicas' observations runs at most once per persist interval.

## Alive is not listening

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
registration.

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
  401/410 stop the daemon.
