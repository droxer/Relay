# Agent handoff: design review and implementation direction

## Recommendation

Treat handoff as a durable request for another logical agent to continue work
in the same thread and workspace. The collaboration conductor authorizes that
request; the daemon delivers it. A handoff is accepted when its intent and
assignment are durable, and starts only when the receiver actually starts a
run. Neither a prompt note nor `session.status = running` proves execution.

Keep the conductor and its prepared-request protocol. Build on its round,
assignment, and attempt identities rather than introducing another scheduler
or an independent handoff queue. Distinguish recovery after a terminal run from
delegating a subtask while a parent remains active. The latter needs work-graph
ownership and result integration, not a call to the recovery endpoint.

The persistence fix, versioned context capture, explicit delivery evidence, and
handoff status UI described below are implemented. Autonomous delegation remains
a separate future feature.

## What the implementation does today

| Surface | Actual behavior | Implication |
| --- | --- | --- |
| `POST /threads/{id}/recoveries` | Conductor resolves a logical target and compiles a recovery round; backend uses prepared admission and daemon delivery | Preferred execution path; preserve its eligibility, affinity, idempotency, and cancellation checks |
| `POST /threads/{id}/handoffs` | Records an executor-targeted decision, assignment artifact, and status | Metadata mutation only; success does not mean the receiving agent was dispatched |
| `POST /threads/{id}/decisions`, kind `handoff` | Records a decision and optionally changes phase | A third meaning of handoff; no receiver assignment or dispatch by itself |
| `SessionController.handoff_session` | Writes the decision, assignment artifact, `assigned` phase, and handoff phase | These must commit together because decision-ID replay otherwise skips unfinished work |
| Registry command staging | Reuses the accepted immutable context and receipt; only legacy rounds without context reconstruct history | Prepared retries cannot silently replace accepted work with newer session text |
| Prompt construction | Prepends progress-file instructions, history, prior results, and target note before the user turn | Workspace evidence and prior output remain necessary; a note alone is insufficient |

Sources: `backend/relay/collaboration/service.py`,
`backend/relay/daemon_registry/node_backend.py`,
`backend/relay/daemon_registry/registry.py`,
`backend/relay/api/session_routes.py`, `backend/relay/sessions/`, and
`packages/relay-core/src/prompts.ts`. Existing architectural constraints are
documented in ADR-011, ADR-013, and ADR-016.

## Immediate fix: an atomic retry receipt

Before this change, failure after `human.decision` left that decision durable
without the final assignment/status transition. Retrying the same decision ID
returned immediately. A caller could therefore observe an apparently accepted
handoff that never finished recording its local state.

The public controller method now wraps the complete operation in the existing
store transaction. Database artifact contents, artifact events, decision,
intermediate status, and final status participate in the same transaction.
Nested calls join an enclosing transaction. Failure leaves the pre-handoff
snapshot intact; retry completes once; subsequent replay adds nothing.

This does not create daemon delivery or replace the conductor admission
protocol. It does not add distributed serialization, reconcile historical
partial writes, or make the legacy file-backed migration store transactional.
The runtime uses the database-backed store.

## Implemented handoff contract

The recovery round carries optional `handoffContext`, using
`relay.handoff.context` version 3 for new captures, with versions 1 and 2
accepted for legacy prepared captures. Versions 2 and 3 require a structured
work receipt; version 3 also requires receiver workspace validation. Its
`decisionId` and `assignmentId` link it to
the decision and receiving assignment. Capture records:

- Source run/assignment when available, receiving logical agent ID, resolved
  executor, and the existing immutable runtime/workspace identity.
- The current user objective (including any acceptance criteria in that text),
  human note, and source event count and final event ID.
- References to terminal run results, artifacts, and the progress file, with
  explicit missing or truncated context indicators.

The manifest stores run/artifact references and bounded excerpts, not complete
transcripts. The inherited prompt fields have a 24,000-character budget:
objective up to 6,000, active note up to 4,000, and remaining space for history.
Up to 5,000 characters are reserved for the latest result, even when a later
historical note is large. Truncation keeps attribution and an omission marker.
References retain the last 24 runs and 48 distinct artifacts, with explicit
missing-output and truncation indicators. Checkpoint files remain agent-authored
evidence and must be verified against the workspace.

The conductor captures context before preparing admission. Prepared-request
replay reuses the persisted manifest, including after interruption before the
round event. Dispatch does not reconstruct frozen context from live session
state. A later user message therefore cannot rewrite accepted work. Legacy
rounds without a context manifest retain their existing reconstruction path;
an unsupported context version fails dispatch explicitly.

New context uses event order, not timestamp ordering. Historical notes from
successive handoffs in the same user turn remain attributed history. Only the
accepted operation's note is active. Report headings include logical identity,
executor, run ID, and terminal status. These changes apply to new handoffs;
legacy bridge/history formatting and turn-boundary behavior remain readable.

## Lifecycle and user-visible behavior

Derive lifecycle from the existing durable request and run events wherever
possible; do not maintain a second mutable status that can disagree with them.

| State | Evidence | User meaning |
| --- | --- | --- |
| Accepted | Durable decision and round linked to prepared request | Relay has accepted the transfer |
| Queued | `collaboration.delivery` with `queued`, after command publication | Waiting for execution capacity/delivery |
| Running | `run.executing` acknowledgement persisted as `collaboration.delivery` with `running`, or output from an older daemon | The named agent has started |
| Completed | Receiver terminal result | Work finished; any verification/outcome policy still applies |
| Failed or cancelled | Admission/delivery/run terminal evidence | Explain the failure and offer an explicit recovery |

The existing admission checks reject handoff while work is in flight. A future “stop and hand off” operation must fence cancellation,
retain partial output, and wait for a terminal boundary before starting a new
writer. Placement or runtime drift should fail visibly, never silently move the
thread to another computer.

## Compatibility and remaining boundaries

The first redesign step makes execution ownership explicit through each new
round's `workScope`. Task runs record their authorized task ID; new messages
record thread scope. Recovery inherits the source round's scope, and prepared
replay retains its persisted task ID. Reference links cannot grant completion
authority in either direction. Legacy task-linked rounds without scope require
a restart through task dispatch, rather than guessing ownership from links.
See `docs/testing/handoff-work-scope.tdd.md` for regression evidence.

The second step adds versioned work receipts with verbatim requirements,
attributed structured checkpoints, and stored artifact hashes. It preserves
initial thread objectives and current requests separately, without extracting
or inventing acceptance criteria from prose. Missing or stale checkpoints mean
unknown progress. Prepared retries reuse accepted receipts even when later task
edits would exceed the new-capture size limit.

The third step is being delivered in two slices. Recovery admission now freezes
the source round/revision and checks it after the durable session reservation.
Stale requests release only their own prepared reservation, leaving the newer
thread/task untouched. Retry accepts its own already-recorded round, never a
later owner. The active-session database uniqueness constraint supplies admission
serialization across replicas; the process-local dispatch lock alone does not.
Legacy prepared manifests lack the token and retain their compatibility path.
This source-round token alone does not establish task ownership across threads;
the active-task reservation described below supplies that separate guarantee.

Runtime receiver validation now compares recorded snapshot hashes with bounded
regular files before preparation/execution. Version 3 handoffs require the
`handoff-validation` daemon capability; prepared older versions keep their
compatibility path. All workspace layouts, including threads, use the physical
workspace gate, so validation runs after a preceding cooperative writer releases
it. Missing hashes remain unknown, and matching partial evidence never certifies
a whole Git tree or completion. See `docs/testing/handoff-runtime.tdd.md`.

Task-wide active reservations now prevent different threads or nodes from
admitting competing requests for one task. Database uniqueness covers all four
active phases, including preparation and finalization; the local store uses its
process-shared claim lock for both creates and transitions. Migration 0068 refuses
pre-existing duplicate owners instead of picking a winner or cancelling metadata.
See `docs/testing/task-ownership-reservation.tdd.md`.

Pre-delivery cancellation now checks command delivery under the same store lock
used by publication and polling. A delivered command, including one with an
expired lease, cannot release its request reservation through that shortcut.
Callers still send `run.cancel`; terminal-event processing remains responsible
for finalization. This does not turn timeout or cancellation intent into proof
of physical process exit.

Task execution now has an event-backed monotonic revision independent of active
reservation lifetime. Recovery freezes the source task revision; prepared replay
reuses its claim, and expired admission retains the original generation. Runtime
task status, activity, round/continuation, and workspace-wait writes check the
request/revision inside the task append transaction. Replaced requests cannot
redispatch or rewrite task results after their replacement finishes. Legacy
snapshot projections cannot reset ownership because the fence reads authoritative
events. See `docs/testing/task-execution-revisions.tdd.md`.

Delayed manual/scheduler dispatch results now check the dispatch claim, execution
owner, and task status under the task write lock. They cannot reopen completed
work or overwrite a replacement's outcome. Delivered timeout/retirement stops
retain ownership until a terminal acknowledgement; a durable stable-id stop
intent survives publication crashes and prevents lease-expiry redelivery.
Acknowledgement replay preserves terminal human decisions, and a late success
cannot override a stop or dispatch its successor.

POSIX local execution terminates and waits for the execution process group before
returning. BoxLite stream failures request termination and wait for confirmed
exit; an unavailable exit result retains the run rather than releasing ownership.
This can require operator recovery after an unrecoverable runtime failure.
The workspace gate is not an OS sandbox: unrelated writers, children that escape
the process group, Windows process trees, and external side effects are not
covered. Upgrade all backend replicas and daemons together; older versions do
not enforce these guarantees. Human edits remain separate and runtime fences do
not revoke API credentials. See `docs/testing/handoff-lifecycle.tdd.md`.

- Existing web recovery callers already use logical-agent `/recoveries`. The
  repository caller inventory found no active chat/core client calling the
  metadata-only `/handoffs` endpoint. Those legacy endpoints remain unchanged
  for external and sandbox consumers, and their semantics are explicit in
  `docs/api.md`.
- New commands opt into `reportExecutionStarted`. New daemons acknowledge after
  workspace preparation and immediately before entering the agent runner.
  Older backends never request it; older daemons ignore it. New acknowledgement
  events use existing node/command/run authorization and require the current
  lease when the command has one.
- `agent.started` remains the legacy backend staging event. It is explicitly
  insufficient to show a handoff as running. Delivery events reference the
  round, assignment, and run; duplicate or delayed queued events cannot regress
  the browser's running state. A newer round hides the old handoff status.
- Context and delivery events survive Python storage, core replay, and browser
  SSE. Those events require no relational migration; active-task reservations
  require migration `20260913_0068`. Terminal lifecycle comes from the
  existing run/session records, not a second mutable handoff status.
- This change does not repair old partial records, make the file-backed
  migration store transactional, or introduce distributed handoff serialization
  beyond existing admission and command claims.
- Autonomous child delegation, interruption followed by transfer, and automatic
  reconciliation of historical partial handoffs remain separate work. They need
  cancellation propagation and result-integration policy rather than a silent
  expansion of recovery semantics.

See `docs/testing/handoff-atomicity.tdd.md` and
`docs/testing/handoff-context.tdd.md` for verification evidence.
