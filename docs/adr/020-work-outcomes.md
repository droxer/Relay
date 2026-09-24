# ADR-020: Separate execution completion from work outcomes

## Status

Accepted. Extends ADR-019 to single-agent action runs and makes the result of
work visible independently of the execution lifecycle.

## Decision

New single-agent action runs on a daemon advertising `work-results` use the
same run-bound work report and required-evidence gates as teams. Team protocol
selection retains its existing behavior. Standalone discussion and review on
the legacy path do not acquire an implementation acceptance requirement.
The admitted request freezes protocol selection; retry cannot silently downgrade
it when a daemon loses the capability.

`session.completed` means execution ended. It additionally records `workOutcome`:

| Value | Meaning |
| --- | --- |
| `reported_done` | Required work reports passed the existing evidence gates; the evidence remains agent-reported. |
| `unfinished` | A valid aggregate report requests continuation and required work has no unresolved findings, missing reports, or blockers. |
| `blocked` | Required reports are missing/invalid, required work needs attention, or execution failed. |
| `needs_review` | Work gates passed but the task requires human acceptance. |
| `unverified` | Execution ended without the work-report contract establishing an outcome. |
| `accepted` | A person explicitly marked the thread done. This does not grant authority over linked tasks. |

The field is event-backed and projected in Python snapshots, thread summaries,
shared TypeScript replay, and browser SSE. Starting new execution clears the
previous outcome. Historical completion events without this field replay as
`unverified`; no SQL migration or historical acceptance backfill is required.

An unfinished report without findings can continue a task under its existing
round budget and workspace affinity. Missing reports, invalid plans, required
failures, and unresolved findings still prevent continuation from bypassing
the acceptance gates. Thread-only runs retain `unfinished` for the next user
turn; this change does not start background task scheduling for conversations.

The work panel displays agent claims as “Reported complete,” not “Accepted.”
The overall outcome remains visible even without a team work graph. Existing
task status and human acceptance policy remain authoritative for the task.

## Boundaries

This is the first implementation slice of the problem-solving harness review.
It does not certify that a reported command ran, introduce autonomous thread
continuation, change team participation defaults, or permit parallel writes.

The next stages should build on this contract:

1. Daemon-produced verification receipts tied to the checked workspace revision,
   with explicit coverage of acceptance criteria and deliverable artifacts.
   An agent-authored string must never become a trusted receipt by parsing it.
2. An event-backed problem record containing constraints, decisions, failed
   approaches, open questions, and the next action; classify failures before
   retrying and stop repeated attempts that make no measurable progress.
3. Capability-based contributor selection and explicit dependencies, with
   verification requirements independent of whether every roster member runs.
4. Representative end-to-end evaluations measuring verified completion, false
   completion, recovery, human intervention, elapsed time, and cost.

All execution and future verification commands continue to run on daemons.
The backend owns dispatch, policy, and durable event recording.
