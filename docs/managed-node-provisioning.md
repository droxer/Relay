# Managed Node Provisioning Design

## Status

Accepted for incremental implementation. The local-first vertical slice is
implemented: managed-node intent and attempt persistence, single-use enrollment
grants, managed daemon linkage, control-plane APIs, daemon enrollment, and the
`local-process` reconciler/provider. PostgreSQL persistence for managed-node
resources, database-backed reconcile leases, remote providers, and the final
control-panel workflow remain rollout work described below.

The user-facing ownership and dispatch model is defined by the accepted
[Agent-First Runtime Design](agent-first-runtime-design.md). Managed nodes remain
infrastructure desired state while user-owned logical agents connect to
runtime nodes through placements.

## Summary

Relay must treat managed-node provisioning as desired-state reconciliation,
not as daemon registration. An administrator requests a managed execution
resource. A provisioning controller asks a provider to create or start that
resource. The daemon running on the resource then enrolls with Relay and
becomes an observed daemon node.

This design separates three concerns that are currently combined by
`POST /api/v1/admin/daemon-nodes` and `relay-supervisor`:

1. the durable intent to operate a node;
2. the provider operation that creates or starts its runtime;
3. the daemon identity that heartbeats and executes leased commands.

The design preserves Relay's core invariants:

- the backend remains the durable control plane and never executes agents;
- daemon nodes remain the only path for agent execution;
- execution providers are replaceable and do not own Relay workflow state;
- command delivery continues to use ADR-010 leases;
- long-lived daemon credentials are not exposed through control-panel reads.

## Goals

- Provision, restart, stop, replace, and delete managed nodes through a durable,
  idempotent reconciliation loop.
- Support local processes first without making process supervision the domain
  model.
- Add remote workstation, VM, Kubernetes, or other providers without changing
  daemon registration or task dispatch.
- Represent dedicated, pooled, shared, and manually enrolled nodes explicitly.
- Survive backend and supervisor restarts without recovering plaintext daemon
  credentials from the backend.
- Expose progress and actionable failure reasons to administrators.
- Prevent duplicate infrastructure when requests or provider calls are retried.

## Non-goals

- Selecting a production cloud provider in this iteration. (Fly Machines was
  added afterwards as the `fly-machines` provider; see
  [deployment.md](deployment.md#cloud-computers-on-fly-machines).)
- Replacing daemon command leasing, run scheduling, or BoxLite guest execution.
- Moving task or session authority into a supervisor or provider.
- Implementing autoscaling from task-queue demand in the first release.
- Migrating manually operated daemon nodes into managed nodes automatically.

## Terminology

| Term | Meaning |
| :- | :- |
| Managed node | Durable Relay intent describing an execution resource that Relay should operate. |
| Provisioning controller | Control loop that reconciles managed-node desired state with provider and daemon state. |
| Provider instance | Provider-owned runtime such as a child process, workstation, VM, pod, or host service. |
| Provisioning attempt | Durable record of one bounded attempt to realize a managed node. |
| Enrollment grant | Short-lived, single-use credential allowing one daemon to claim one provisioning attempt. |
| Daemon node | Observed, enrolled execution-plane process that heartbeats, reports agent readiness, and executes leased commands. |
| Manual node | Daemon node enrolled by an operator and not reconciled by a managed-node controller. |

## Design principles

### Desired state and observed state are separate

Creating a managed node records intent. It does not create a daemon-node row.
A daemon node exists only after a daemon has enrolled successfully.

### Reconciliation is level-triggered

The controller repeatedly compares desired state with observed state. It must
not depend on receiving every transition event or retaining child processes in
memory. Repeating reconciliation after a crash must converge safely.

### Provider operations are idempotent

Every provider operation is keyed by the managed-node ID and generation. An
`ensure` retry must return or repair the same provider instance instead of
creating a duplicate.

### Bootstrap credentials are not runtime credentials

Providers receive a short-lived enrollment grant. The daemon exchanges it for
its runtime identity during enrollment. Relay never needs to return a reusable
daemon token to a supervisor on a later reconciliation pass.

### Provisioning policy is explicit

"One node for every user" is a policy, not a registry invariant. The first
policy may remain dedicated-per-user, but it must create managed-node
specifications rather than infer desired state from the user list forever.

## Architecture

```text
admin / policy
      |
      | create or update desired state
      v
managed_nodes  <--------- provisioning controller
                              |          ^
                              | ensure   | inspect
                              v          |
                        provider adapter -------- provider instance
                                                     |
                                                     | start relay-daemon
                                                     v
daemon enrollment endpoint <--- single-use enrollment grant
      |
      | create and bind runtime identity
      v
daemon_nodes ---> heartbeat / readiness / command leases / run events
```

The provisioning controller belongs to the control-plane deployment but is not
part of request handling. It may initially run as the `relay-supervisor`
process. Its durable state remains in the backend database so another
controller instance can resume reconciliation.

## Domain model

### ManagedNode

`ManagedNode` is the durable desired-state resource.

| Field | Type | Notes |
| :- | :- | :- |
| `id` | UUID | Stable idempotency key across provider retries. |
| `displayName` | string | Operator-facing name. |
| `userId` | UUID, nullable | Owner for dedicated nodes; null for pooled nodes. |
| `assignmentMode` | enum | `dedicated`, `pooled`, or `shared`. Only `dedicated` is currently accepted (`MANAGED_NODE_ASSIGNMENT_MODES` in `backend/relay/core/managed_node_policy.py`); `pooled`/`shared` are reserved for the assignment-policy work below. |
| `provider` | string | Provider adapter name: `local-process`, or `fly-machines` for cloud computers. A request that names none gets the deployment's `RELAY_MANAGED_NODE_PROVIDER`. |
| `providerConfigRef` | string, nullable | Reference to server-side provider configuration; never embedded credentials. |
| `profile` | string | Named capacity/runtime profile such as `standard`. |
| `sandboxMode` | enum | `boxlite`, or `none` on a provider that gives each computer its own VM (`fly-machines`, where BoxLite cannot boot); the provider fixes it (`managed_sandbox_mode_for`). |
| `workspacePolicy` | JSON | Provider-neutral workspace intent, not a guessed guest path. |
| `desiredState` | enum | `running`, `stopped`, or `deleted`. |
| `generation` | integer | Incremented whenever provider-relevant desired state changes. |
| `phase` | enum | Current reconciliation phase. |
| `activeAttemptId` | UUID, nullable | Current attempt, if any. |
| `activeDaemonNodeId` | UUID, nullable | Enrolled runtime currently serving this resource. |
| `conditions` | JSON array | Structured readiness and failure conditions. |
| `createdAt` / `updatedAt` | timestamp | Audit timestamps. |

Only one non-deleted dedicated managed node may be active for the same user
and policy slot. This constraint is enforced in storage, not by list ordering.

The provider resolves `workspacePolicy` to one node workspace root before it
starts the daemon. In accordance with [ADR-013](adr/013-thread-scoped-workspaces.md),
the daemon—not the provider or backend—creates `<root>/.threads/<thread-id>` and
selects that directory as the run working directory (a thread that already has
a `<root>/<thread-id>` directory from before `.threads/` keeps it). User-owned nodes receive their
root from user setup; cloud providers provision it, including persistence
or recovery appropriate to the provider. Sessions created before the
thread-layout event field continue at the legacy node root after an upgrade;
Relay does not copy an ambiguous shared root into a thread automatically.

Thread records sit in `.relay/threads/<threadId>/HANDOFF.*` inside a
workspace, beside Relay's other control files. The `relay-thread-records`
capability identifies daemons that create, migrate, and snapshot them there;
`dot-thread-records` identifies the earlier daemons that use
`.threads/<threadId>/`, and an older daemon still keeps
`threads/<threadId>/`. The backend names the newest directory the receiving
daemon advertises, and a handoff accepted with a `.relay/threads/` or
`.threads/` path requires a daemon with the matching capability before
delivery. The daemon moves a thread's older records forward on its next run
when that directory holds nothing but record files (at a node root,
`.threads/<id>/` is a thread's whole workspace and is never moved). The
Activity browser combines all three record roots, so historical records remain
accessible without another run. When records move, receipt validation can
resolve a missing older handoff file at its new path while still enforcing the
recorded hash and rejecting symlinks.

### ProvisioningAttempt

| Field | Type | Notes |
| :- | :- | :- |
| `id` | UUID | Attempt identity. |
| `managedNodeId` | UUID | Parent desired resource. |
| `generation` | integer | Desired generation this attempt realizes. |
| `attemptNumber` | integer | Monotonic within a generation. |
| `status` | enum | `pending`, `claimed`, `allocating`, `bootstrapping`, `registering`, `succeeded`, `failed`, or `cancelled`. |
| `providerInstanceId` | string, nullable | Stable provider handle. |
| `providerOperationId` | string, nullable | Optional asynchronous operation handle. |
| `startedAt` / `finishedAt` | timestamp | Attempt timing. |
| `errorCode` | string, nullable | Stable machine-readable reason. |
| `errorMessage` | string, nullable | Sanitized operator detail. |
| `retryAt` | timestamp, nullable | Backoff deadline. |

Attempt records are append-only except for lifecycle fields belonging to the
same claimed attempt. They provide an audit trail and prevent a single mutable
`lastError` from hiding previous failures.

### EnrollmentGrant

The database stores only a hash of the enrollment secret.

| Field | Type | Notes |
| :- | :- | :- |
| `id` | UUID | Public grant identifier. |
| `attemptId` | UUID | Attempt allowed to enroll. |
| `secretHash` | text | Hash of the one-time secret. |
| `expiresAt` | timestamp | Short expiry, initially 15 minutes. |
| `consumedAt` | timestamp, nullable | Set atomically on successful enrollment. |
| `revokedAt` | timestamp, nullable | Set when an attempt is cancelled or superseded. |

The plaintext credential uses the form `<grant-id>.<secret>` and is delivered
to the provider only when the grant is issued. It must not be retrievable
later.

### DaemonNode additions

Existing daemon-node storage remains the observed execution-plane record. Add:

| Field | Type | Notes |
| :- | :- | :- |
| `managedNodeId` | UUID, nullable | Null identifies a manual node. |
| `provisioningAttemptId` | UUID, nullable | Attempt that enrolled this runtime. |
| `credentialVersion` | integer | Supports runtime credential rotation. |
| `retiredAt` | timestamp, nullable | Prevents replaced runtimes from becoming active again. |

At most one non-retired daemon node may be active for a managed node. Replacing
a runtime retires its previous identity before the replacement can receive new
run commands. Active work must be drained or cancelled according to policy.

## State model

### Managed-node phases

| Phase | Meaning |
| :- | :- |
| `requested` | Desired resource exists but no controller owns an active attempt. |
| `allocating` | Provider is creating or locating the runtime. |
| `bootstrapping` | Provider instance exists and is starting the daemon. |
| `registering` | Relay is waiting for daemon enrollment and readiness. |
| `ready` | A live linked daemon reports usable agent capacity. |
| `draining` | No new work is assigned while active work finishes or is cancelled. |
| `stopped` | Provider runtime is stopped and no linked daemon is active. |
| `deleting` | Provider resources and runtime identity are being removed. |

Failure is represented as a condition rather than a terminal phase:

```json
{
  "type": "Provisioned",
  "status": "false",
  "reason": "provider_quota_exceeded",
  "message": "The provider rejected allocation because the project quota is exhausted.",
  "observedGeneration": 3,
  "lastTransitionAt": "2026-07-10T09:00:00Z"
}
```

This allows a node to remain in `allocating` while reporting a retryable
allocation failure, instead of overloading a single `failed` status.

### Readiness

A managed node is ready only when all of the following are true:

- the desired state is `running`;
- the provider instance is healthy;
- a non-retired daemon is linked to the current generation;
- its heartbeat is live;
- at least one non-disabled agent is ready;
- the daemon protocol version is supported.

Task dispatch continues to validate the exact requested agents and available
capacity at dispatch time.

## Reconciliation algorithm

For each managed node, the controller obtains a short database-backed reconcile
lease. Multiple controller replicas may run, but only the current lease holder
mutates one resource at a time.

### Desired state: running

1. Load the managed node, active attempt, linked daemon, and provider status.
2. If the linked daemon is live and compatible with the current generation,
   publish readiness and stop.
3. If an attempt is active, inspect its provider operation and advance or fail
   it. Do not create another attempt.
4. If the retry deadline has not arrived, stop.
5. Create a new attempt and one enrollment grant in one transaction.
6. Call `provider.ensure()` using `(managedNodeId, generation)` as the
   idempotency key.
7. Persist the provider instance handle before waiting for enrollment.
8. Move to `registering` once the provider reports that bootstrap was accepted.
9. If enrollment or readiness misses its deadline, inspect the provider before
   retrying. Reuse a healthy instance when possible; otherwise stop/delete it
   according to provider policy and create a new attempt after backoff.

### Desired state: stopped

1. Mark the node draining so scheduling rejects new work.
2. Wait for active runs, or cancel them when the configured drain deadline
   expires.
3. Ask the provider to stop the instance idempotently.
4. Retire the daemon identity after the provider confirms stop.
5. Set the managed-node phase to `stopped`.

### Desired state: deleted

Follow the stop flow, call `provider.delete()`, revoke outstanding enrollment
grants, retire linked daemon identities, and retain a tombstone/audit record.

### Controller recovery

On restart, the controller reads active attempts and uses provider instance and
operation IDs to resume inspection. It never requires an in-memory child map or
a plaintext daemon credential. For the local provider, the provider instance
must include a persistent host process identity or service handle; a bare PID
is sufficient only for development mode.

## Provider contract

```ts
interface ManagedNodeProvider {
  readonly name: string;

  ensure(input: EnsureManagedNodeInput): Promise<ProviderInstance>;
  inspect(instanceId: string): Promise<ProviderInstanceStatus>;
  stop(instanceId: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
}

interface EnsureManagedNodeInput {
  managedNodeId: string;
  generation: number;
  profile: string;
  sandboxMode: "boxlite";
  workspacePolicy: WorkspacePolicy;
  enrollment: {
    backendUrl: string;
    credential: string;
    expiresAt: string;
  };
}
```

Contract requirements:

- `ensure()` is idempotent for `(managedNodeId, generation)`.
- provider adapters do not call task, session, or run APIs;
- returned errors include stable codes and retryability;
- credentials are redacted from logs and provider status;
- `inspect`, `stop`, and `delete` tolerate already-absent resources;
- providers report their instance handle before lengthy readiness waits.

The current `LocalDaemonLauncher` becomes a development
`local-process` provider. `CommandTemplateLauncher` may remain as an explicitly
best-effort compatibility provider, but shell templates are not the long-term
cloud-provider interface.

## Enrollment protocol

### Request

```http
POST /api/v1/daemon-node-enrollments
Authorization: Enrollment <grant-id>.<secret>
Content-Type: application/json
```

```json
{
  "protocolVersion": "1",
  "instanceIdentity": {
    "provider": "local-process",
    "instanceId": "relay-managed-node-..."
  },
  "supportedAgents": ["claude", "codex", "pi", "kimi"],
  "maxConcurrentRuns": 1
}
```

The implemented local-process slice posts only `{"workspacePath": ...}`; the
remaining fields above are the target contract and are not yet read by the
backend.

### Transactional validation

The backend must atomically verify that:

- the grant hash matches and has not expired, been revoked, or been consumed;
- the attempt is active and belongs to the current managed-node generation;
- the provider and instance identity match the attempt when the provider can
  attest them;
- the managed node still desires `running`;
- no current non-retired runtime identity already owns the managed node.

On success, the transaction consumes the grant, creates the daemon-node
identity, links it to the managed node and attempt, and marks the attempt
`succeeded`.

### Response and runtime credentials

The response contains the daemon-node ID, sandbox mode, heartbeat settings,
and a runtime credential. The runtime credential is stored by the daemon in the
provider's secret mechanism or local protected state, not returned by
control-panel APIs. Credential rotation creates a successor credential and
revokes the old one after a bounded overlap.

If the enrollment response is lost, repeating the request with the consumed
grant returns the same daemon identity only when the request carries the same
attempt and instance proof. Otherwise it fails closed. This makes enrollment
idempotent without allowing a consumed grant to enroll a second runtime.

## Control-plane API

### Managed-node administration

```text
POST   /api/v1/admin/managed-nodes
GET    /api/v1/admin/managed-nodes
GET    /api/v1/admin/managed-nodes/{id}
PATCH  /api/v1/admin/managed-nodes/{id}
DELETE /api/v1/admin/managed-nodes/{id}
POST   /api/v1/admin/managed-nodes/{id}/attempts
GET    /api/v1/admin/managed-nodes/{id}/attempts
POST   /api/v1/admin/managed-nodes/{id}/recover
DELETE /api/v1/admin/managed-nodes/{id}/runtime
DELETE /api/v1/admin/managed-nodes/{id}/record
```

`POST` returns `202 Accepted` because infrastructure and daemon readiness are
asynchronous. It never returns a daemon command or runtime token.

Retry is represented by creating an attempt with `{ "replaceActive": true }`.
Drain patches the managed node with `{ "desiredState": "stopped" }`. Deleting
the managed-node resource requests managed teardown; deleting `/record` removes
an already-terminal historical record synchronously.

Example request:

```json
{
  "displayName": "Alice development node",
  "userId": "alice",
  "assignmentMode": "dedicated",
  "provider": "local-process",
  "profile": "standard",
  "sandboxMode": "boxlite",
  "workspacePolicy": { "kind": "user-home" },
  "desiredState": "running"
}
```

Example response:

```json
{
  "node": {
    "id": "...",
    "phase": "requested",
    "desiredState": "running",
    "generation": 1,
    "conditions": []
  }
}
```

### Existing daemon-node API

`GET /api/v1/admin/daemon-nodes` remains the observed fleet view and adds the nullable
`managedNodeId`. Both manual and managed runtimes renew the same explicit
heartbeat lease through `POST /api/v1/daemon-nodes/{id}/heartbeat`; the managed
reconciler alone decides whether expiry should replace infrastructure. Command
polling remains a compatibility liveness signal and continues renewing command
leases for older daemons.

The current `POST /api/v1/admin/daemon-nodes` is retained for manual
enrollment only. It should be renamed or replaced with an explicit manual-node
enrollment flow so the UI does not describe credential generation as managed
provisioning.

## Assignment policies

Provisioning and scheduling are related but separate.

### Dedicated

The managed node has one `userId`. Scheduler authorization and session
ownership continue to enforce that assignment. A policy controller may create
one dedicated managed node for each eligible user, but user existence
alone is not permanent provisioning intent.

### Pooled

The managed node has no permanent user. The scheduler selects it using
capability, capacity, workspace, and policy constraints. Task/session ownership
does not change when a pooled node executes work.

### Shared

The managed node accepts multiple user sessions up to declared capacity.
Workspace isolation and credential injection must be per run. Shared mode must
not be enabled until those isolation rules are enforced.

### Manual

Manual daemon nodes are not represented by `ManagedNode` and are never started,
stopped, or deleted by the provisioning controller. Operators own their
lifecycle.

## Workspace semantics

Do not use one ambiguous `workspacePath` as both provider host path and daemon
guest path. `workspacePolicy` expresses intent, for example:

```json
{ "kind": "user-home" }
```

or:

```json
{
  "kind": "existing-host-path",
  "path": "/srv/relay/workspaces/alice"
}
```

The provider resolves that policy into provider-specific placement. The daemon
continues to report its effective host workspace and guest mount information as
observed fields. The backend must not fabricate a path merely to create a
pending node.

## Security

- Enrollment grants expire quickly, are single use, and are scoped to one
  attempt and generation.
- Only credential hashes are stored for enrollment grants.
- Runtime daemon credentials are never placed in URL parameters, UI payloads,
  or control-panel list responses.
- Providers should inject enrollment credentials through a secret/file
  mechanism. Command-line arguments are allowed only for the local development
  provider because they may be visible in process listings.
- Provider configuration stores references to secrets, never provider secrets
  in managed-node JSON.
- Enrollment, retry, drain, replacement, and deletion emit audit events.
- A stale or retired daemon identity cannot resume polling commands even if it
  later sends a heartbeat.
- Provider adapters run with the minimum permissions needed for their assigned
  provider configuration.

## Failure handling

| Failure | Controller behavior |
| :- | :- |
| Provider request times out | Inspect by idempotency key before retrying. |
| Provider quota or policy rejection | Record non-retryable condition until configuration changes or an admin retries. |
| Instance starts but daemon never enrolls | Inspect instance, rotate the enrollment grant once, then replace after bounded retries. |
| Enrollment response is lost | Return the same identity for the same consumed grant and verified instance. |
| Daemon stops heartbeating | Drain/retire it and restart or replace according to policy. |
| Controller crashes | Resume from active attempt and provider handles. |
| Backend replica changes | Database-backed reconcile leases and durable attempts preserve ownership. |
| Desired generation changes mid-attempt | Cancel or supersede the old attempt and revoke its grant. |
| Delete requested during a run | Drain first; force cancellation only after configured deadline. |

Initial retry policy should use exponential backoff with jitter, a maximum
automatic retry count per generation, and explicit admin retry after a
non-retryable failure.

## Observability

Metrics:

- reconciliation duration and result by provider;
- provisioning attempt count and latency;
- time from request to enrollment and readiness;
- provider failures by stable error code;
- enrollment rejection reason;
- managed nodes by desired state, phase, and readiness;
- orphaned provider instances and unlinked daemon nodes.

Structured logs must include `managedNodeId`, `generation`, `attemptId`,
`provider`, and `providerInstanceId` where known. They must never include
enrollment or runtime credentials.

The admin UI should show a timeline derived from provisioning attempts and
conditions rather than only the latest `lastError`.

## Rollout plan

### Phase 1: Model and enrollment boundary

- Add managed-node, attempt, and enrollment-grant persistence.
- Add the enrollment endpoint and nullable managed-node linkage on daemon
  nodes.
- Preserve current manual daemon registration.
- Add unit tests for grant expiry, single use, idempotent retry, generation
  mismatch, and runtime replacement.

### Phase 2: Local managed provider

- Convert `relay-supervisor` into a reconciler over managed-node resources.
- Implement the `local-process` provider using the provider contract.
- Persist attempt and provider instance handles before waiting for readiness.
- Remove the user-list inference loop from the default controller path.
- Keep dedicated-per-user as an optional policy controller.

### Phase 3: Control-panel workflow

- Add managed-node APIs and asynchronous progress presentation.
- Change “Generate node” to either “Provision managed node” or “Create manual
  enrollment,” depending on the selected workflow.
- Display desired state, provider state, linked daemon readiness, attempts, and
  structured errors separately.

### Phase 4: Credential and compatibility cleanup

- Stop persisting or recovering plaintext daemon-node tokens for managed nodes.
- Remove supervisor dependence on `POST /api/v1/admin/daemon-nodes` returning
  `daemonEnv`.
- Deprecate ambiguous sandbox provisioning paths once web callers use the
  explicit managed or manual workflows.

### Phase 5: Remote provider

- Implement one provider with durable external identity, such as a workstation,
  VM, or Kubernetes adapter.
- Validate controller recovery, replacement, and deletion under real provider
  failures before declaring the provider contract stable.

## Compatibility strategy

During migration, Relay supports two disjoint paths:

| Path | Ownership | Creation |
| :- | :- | :- |
| Managed | Provisioning controller | `POST /api/v1/admin/managed-nodes`, followed by daemon enrollment |
| Manual | Operator | Existing daemon-node registration/enrollment workflow |

Existing daemon nodes remain manual. No migration should synthesize managed
intent from a live daemon because Relay cannot know whether it is authorized to
stop or delete that provider resource.

The legacy supervisor can run only until the local managed provider reaches
feature parity. It must not reconcile the same user or runtime as the new
controller.

## Acceptance criteria

- Creating a managed node returns before provider allocation completes and
  exposes observable progress.
- Repeating create with the same idempotency key does not create another
  managed node or provider instance.
- Restarting the controller during allocation or registration resumes the same
  attempt.
- No control-panel or supervisor read API returns a reusable daemon runtime
  credential.
- A single enrollment grant cannot create two active daemon identities.
- A superseded or retired daemon cannot poll or renew command leases.
- Changing provider-relevant configuration increments `generation` and causes
  controlled replacement.
- Stop and delete drain active work before retiring daemon identity and provider
  resources.
- Manual nodes continue to register and execute without being reconciled.
- Provider errors are visible as structured conditions and attempt history.

## Decisions required before implementation

1. Choose the first durable credential mechanism for locally managed daemons:
   protected state file, OS keychain, or a short-lived renewable certificate.
2. Decide whether the provisioning controller runs inside the backend process
   or remains a separately deployed `relay-supervisor`. A separate process is
   preferred for provider privilege isolation.
3. Define the initial named execution profiles and which fields increment a
   managed node's generation.
4. Choose the first remote provider used to validate the abstraction.
5. Define drain deadlines and whether forced cancellation is enabled by default.
