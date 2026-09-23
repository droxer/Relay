# ADR-019: Team responsibilities, bounded delegation, and work acceptance

## Status

Accepted. Extends ADR-016. Execution remains sequential on the thread's node;
the backend never executes an agent. Provider-native subagents remain internal
to one Relay assignment.

## Decision

A team is a persistent roster. Membership may override an agent's default role
and define a responsibility, expected outputs, participation (`always` or
`on_request`), and whether that contribution is required. Team acceptance
criteria supplement the current user goal; they do not replace it. Roles and
responsibilities grant no permissions. Existing agent authorization, placement,
and tool-policy checks still apply.

The lead coordinates first and explicitly synthesizes last for accomplish work.
Review and discussion retain lead-last synthesis. Each turn has its own stable
assignment identity, even when the same logical agent owns several turns.
Every regular member is required by default, so the lead must delegate a
bounded contribution to each member before reviewing and delivering the result.
Explicit membership settings override those defaults.
On-request members participate only when addressed and do not block normal
dispatch merely because they are offline or disabled.

On a `work-results` daemon, a multi-member accomplish round's coordinator must
propose bounded work through `work.plan` in its run-bound result file. Each item
names an already-authorized participant, objective, acceptance criteria, and
expected outputs. Plans cannot change executors, placement, permissions, or the
required contribution set. Optional specialists can be omitted; an empty plan
is valid only if no specialist is required. Selected work becomes required.
Verification and review follow implementation in stable role order.

The conductor records a new immutable `collaboration.round.started` manifest
with `source: lead_plan`, `parentRoundId`, and the original work scope before
dispatching the plan. Deterministic assignment/round identities and the existing
terminal claim/outbox boundary make replay idempotent. The delegation policy is
`lead-plan-v1`; historical manifests remain readable.

Every participating assignment reports `work.status`, evidence, and optionally
findings or typed messages. `agent.completed.workResult` is the authoritative
attributed report, projected consistently in Python, shared TypeScript, and SSE.
An exit code of zero is execution evidence, not acceptance. A `done` work report
requires nonempty evidence and no unresolved findings. These are agent claims,
not a guarantee that the reported checks were actually executed; independent
verification/review supplies the additional evidence required by team policy.

Required failures, missing evidence, invalid plans, and unresolved required work
prevent task completion even when the final synthesizer reports `done`. Existing
human acceptance policies still apply after the work gates pass. A failed
optional consultation does not itself veto completion.

## Repair and communication

`continue` with findings addressed to earlier implementation work sends the
round back to that owner. All downstream evidence is invalidated. The owner
repairs; subsequent participants revalidate within their own roles. Reviewers
are not instructed to perform the implementation owner's repair.

A runtime failure reported through either `run.failed` or a nonzero
`run.completed` follows the same bounded coordinator repair policy. A granted
coordinator repair can change the shared workspace, so it invalidates prior
work acceptance and restarts the member sequence. Every member revalidates
before the task can finish; the repair and consultation budgets are retained.

Messages are typed as question, answer, blocker, handoff, or decision and are
attributed to an assignment. They are delivered at assignment boundaries.
A blocked/unfinished participant may ask an earlier work item a question; the
recipient gets a bounded answer turn, then the requester resumes. A missing
answer or exhausted budget requires human attention. This is not concurrent
chat or a live interrupt channel.

There are at most 16 proposed specialist items, two semantic repair cycles, and
two teammate consultations per request. Existing delivery retries, timeouts,
cancellation fences, task continuation limits, and human approval boundaries
remain separate. Evidence in prompts is excerpted; full reports remain in the
event log. Work scope descriptions are coordination contracts, not filesystem
sandbox boundaries.

## Compatibility and UI

Multi-member accomplish rounds, including teams without custom configuration,
carry `teamSnapshot.workContractVersion: 1` and require `work-results` support.
Teams with explicit membership configuration or acceptance criteria also require
this contract.
Unsupported daemons are rejected with an upgrade message. Unconfigured
single-member, discussion, review, and recovery rounds retain the legacy verdict
path on older daemons. Historical runs are shown as
unverified rather than retrospectively accepted.
Protocol selection is frozen in the admitted request and cannot silently
downgrade during retry.

Team configuration lives in the existing event-backed JSON snapshots, so no SQL
column migration or backfill is required. Membership removal prunes its config.
The editor exposes responsibilities and acceptance criteria. Threads show owners,
dependencies, evidence, messages, and distinct pending/running/accepted/stale/
unverified/changes-requested states. A new upstream attempt makes an older
downstream review stale in the view.

Parallel writable work, cross-node teams, and independently enforced per-path
permissions are outside this decision. They must not be inferred from a role,
brief, or an agent's plan.
