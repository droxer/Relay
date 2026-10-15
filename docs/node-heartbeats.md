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
   renew liveness and delivery ownership in one lightweight request.
5. Command polls and run events still update `lastSeenAt` for compatibility
   with older daemons, but neither traffic pattern defines liveness.

The default policy renews every 5 seconds and expires after 15 seconds. The
backend timestamps accepted observations, so daemon clock skew cannot extend a
lease. Durable `lastSeenAt` writes remain throttled and are not appended to the
event log.

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
- A graceful shutdown registers `stopped`; an ungraceful exit is detected by
  lease expiry.
