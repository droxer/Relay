# ADR-016: Make the Collaboration Conductor the Workflow Authority

## Status

Accepted. This supersedes the client- and daemon-shaped workflow ownership
described as a limitation in [ADR-014](014-agent-team-round-contracts.md).
ADR-014's assignment identity, roster snapshot, and repair invariants remain in
force.

## Context

Relay previously exposed its execution mechanism as its collaboration model.
Clients submitted assignment arrays, the daemon run request stored a
`currentIndex`, and terminal daemon events advanced that cursor. The same data
therefore meant both "what the team agreed to do" and "what delivery happens
next."

That coupling made ordinary evolution expensive. Adding a discussion protocol,
live membership between rounds, dependency-aware parallel work, or a different
completion rule required coordinated changes in every client and the daemon
registry.

## Decision

Relay owns team collaboration in an event-sourced **Collaboration Conductor**.
Its public inputs describe intent, not transport:

- offer work with `accomplish`, `discuss`, or `review` intent;
- optionally address one or more current room members;
- request typed `rerun` or `handoff` recovery;
- retain legacy run input only as a compatibility adapter.

The conductor resolves current team membership, authorization, placements, and
runtime affinity. It then compiles the contribution into an immutable round
manifest using the versioned `relay.collaboration.round` contract. A manifest
contains stable collaboration, round, and assignment identities; addressing;
the roster revision used for the round; strategy; and completion policy.

Version 2 of that manifest adds a versioned
`relay.collaboration.work-graph`. Each graph item is a durable delegated
subtask with the assignment identity it compiles to, one owning logical agent,
an objective, a semantic work kind, and explicit predecessor work-item IDs.
The graph also identifies the aggregate-result owner. Historical version 1
manifests remain readable; the work graph is optional in shared projections for
that reason. New clients consume the graph as workflow state and still never
submit daemon assignments.

Delegation authority belongs to the conductor, not to the team lead or a
daemon prompt. The graph records `sequential-role-delegation-v1`: stable role
ordering plus a distinct ordinal scope for every item. Dependent later items
are told to consume predecessor results and take an unclaimed slice, so
repeated specialist roles do not receive indistinguishable work. Independently
eligible discussion and review items are labeled as such and do not claim
predecessors. The lead coordinates the round but is never falsely recorded as
having authored an immutable plan before its turn ran. Empty predecessor lists
are retained in agent-run events and projections, distinguishing an
authoritative root item from legacy data with no graph.

`collaboration.round.started` is the authoritative event. Python, shared
TypeScript, and browser SSE projections expose the same ordered manifest list,
active IDs, and monotonic `collaborationRevision`. Membership is fixed inside a
manifest and re-read when the next round opens.

The advancement and failure rules are pure collaboration policy. The daemon
registry applies their decisions and owns only delivery concerns: capacity,
leases, command staging, output, and retries. Admission first creates a durable
`prepared` run request. That state reserves the session and runtime capacity but
cannot be claimed by a daemon. The conductor then appends the user/decision and
`collaboration.round.started` events, activates the request, stages its command,
and publishes it. Each `run.start` command carries a single
`assignment-attempt` delivery envelope referencing its immutable round and
assignment. This prepared-request plus staged-command path is the outbox
boundary: the assignment is authorized and recorded before a daemon can claim
it.

Idempotency keys are scoped by actor and thread before they identify a run
request. A persisted semantic-request fingerprint rejects reuse of a key for
different work. `userMessageId` is the message endpoint's default idempotency
key. If event persistence is interrupted after admission, a retry resumes the
same prepared request and reuses its immutable manifest; event IDs, decision
IDs, and round IDs prevent duplicate authoritative entries.

Prepared admission is itself reconciled. If the round event is durable, the
reaper activates the original request after a process interruption. If the
event never committed, the reservation expires after a bounded lease (60
seconds by default) and releases session/runtime capacity. Keyed new-thread
admission derives the session identity from the scoped operation key, so
concurrent retries converge on one session and one run request.

Activation is a prepared-to-running compare-and-set and rechecks the session
before command staging. Cancellation and terminal session decisions therefore
cannot race a prepared request into daemon delivery. A persistent cancellation
fence is checked while claiming, staging, linking, and atomically publishing a
command, including across backend replicas and reaper recovery. Terminal user
and linked-task decisions establish the same fence, and daemon polling rejects
queued commands whose request or session is no longer live. An expired new-thread
admission records an authoritative failure; replay of the same operation may
reopen only that exact admission-expiry outcome, using an authoritative running
status event that clears the stale outcome. A later cancellation, completion,
or unrelated failure is never resurrected by replay.

The compatibility run request may retain a private sequential cursor while the
execution plane migrates. That cursor is not workflow truth and is absent from
the client interface. Future dependency-graph scheduling or custom completion
policies can change the reconciler and manifests without changing message or
recovery callers.

Discussion rounds run non-facilitators first and the team lead last, allowing
the facilitator to synthesize the room. Accomplish rounds run the writable lead
as coordinator first, then stable role phases: planning, implementation/repair,
verification, and review. A lead's specialist default never turns that initial
coordination step read-only. Review rounds run the lead last and use the
manifest's synthesis policy. These orders are a conservative sequential
execution of the work graph; a future reconciler may schedule independent
ready items in parallel without changing clients or the manifest vocabulary.

## HTTP Interface

```text
POST /api/v1/threads/{threadId}/messages
POST /api/v1/threads/{threadId}/recoveries
```

Message requests contain `text`, semantic `intent`, and optional
`addressAgentId` or `addressAgentIds`, `userMessageId`, and `idempotencyKey`. Recovery requests
contain `kind`, `targetAgentId`, `mode`, an optional note, and an optional
`idempotencyKey`. Neither interface accepts daemon IDs, executor kinds, or
assignment arrays.

## Consequences

- Web and future chat clients use one stable intent-first contract.
- Session events can reconstruct the exact team and policy used for every
  round.
- Disabled-team recovery remains possible without allowing normal work or
  outside agents into that room.
- Daemon delivery can be retried at least once without changing logical
  assignment identity.
- A collaboration round cannot become daemon-claimable before its
  authoritative session events are durable.
- Delegation and subtask ownership are reconstructible from session history;
  they are not inferred from prompts or daemon telemetry.
- Assignment prompts and run projections carry the same work-item identity and
  dependency context as the authoritative graph.
- The legacy `/agent-runs` route remains a compatibility adapter for new-thread
  creation and older callers; continued-thread web traffic uses the conductor.

## Verification

Coverage must prove semantic room and narrowed messages, disabled-team recovery,
task manifests, stable assignment IDs, versioned contracts, lead-last
discussion, revision parity across projections, pure advancement policy, and
single-assignment daemon delivery envelopes.

## Handoff context and execution evidence

### Direct delegation without a Team

An individual action round may offer targets from its requesting Logical
Agent's `delegationAgentIds` permission. The default is empty. Targets must be
other owned Agents on the same Computer, with an active, ready Placement; a
Project round additionally limits targets to its Project Agent roster. The
conductor freezes resolved candidates in the admitted manifest, and delivery
revalidates Agent configuration, Placement and the requester's current grant.
The Computer must advertise `direct-delegation` and `work-results`; older
clients continue normal individual work without offering delegation.

The runtime-neutral request is `work.delegation` in a `continue` work report:
`{agentId, objective, context?, acceptanceCriteria, expectedOutputs}`. It names
no executor, node, or permission override. The conductor compiles it into an
immutable `direct_delegation` child manifest before dispatch: the yielded turn,
the optional delegate contribution, and a required requester continuation.
Deterministic identities make a replay after manifest persistence idempotent.
The existing daemon queue, workspace, cancellation fence, task execution owner,
and finalization recovery remain authoritative.

The requesting Agent yields its process slot. The delegate's completion,
blocker, missing report, or confirmed runtime failure returns control to that
Agent with attributed predecessor context. A failed delegate does not by itself
block the parent Task. Only the requester continuation can report the original
work done; human acceptance is unchanged. Unavailable or revoked targets are
refused and the requester receives one bounded continuation explaining the
refusal, with further delegation disabled. If a delegate becomes ineligible
after plan persistence but before delivery, confirmed non-delivery returns the
failure to the requester too; an already dispatched run still requires exit
evidence. There is one active delegation at a time, at most two per round, and no
nested delegation. Team rounds retain their existing planning contract.

The thread receipt names requester, target, objective, deliverables, criteria,
and the returned report. Execution needs daemon acknowledgement or output;
staging alone is only queued. Requester-reported completion is distinguished
from process exit and human acceptance.

### Handoff evidence

New handoff rounds include an optional versioned `handoffContext` linking the
receiving assignment and decision to captured event boundaries, logical-agent
identity, runtime/workspace identity, run/artifact references, and bounded
context excerpts. Prepared admission freezes this context; staging retries do
not reconstruct it from newer session state. Older rounds without the field
continue through legacy continuity reconstruction.

`agent.started` is a backend staging record, not proof of execution. Handoff
commands request `reportExecutionStarted`; the daemon sends `run.executing`
after workspace preparation and before entering the runner. The backend records
`collaboration.delivery` events for queued and running evidence. The UI derives
handoff lifecycle from these and existing terminal records. Older daemons remain
compatible, with output serving as evidence of execution. The new acknowledgement
uses the existing authorization boundary and requires a matching active lease.
