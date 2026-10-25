# ADR-023: Collaboration style templates and human steps

## Status

Proposed. Extends ADR-016, ADR-019, and ADR-021.

## Context

ADR-021 made a collaboration style the one choice that decides which team
members take an accomplish round and in what order; everything after the
round is compiled (work gates, repair, waits, delivery) is shared. In code,
though, each style is a branch, not data:

- `collaboration/styles.py` resolves the style and fills Build → Review slots.
- `teams/dispatch.py` compiles turns (`_styled_assignments`, `_STYLE_BRIEFS`),
  and Lead-led is a separate branch of `team_member_assignments`.
- `collaboration/manifest.py` maps styles to policies (`STYLE_POLICIES`), and
  `collaboration/policy.py` lists them again (`INSPECTING_STYLES`).
- `web/src/lib/collaborationStyle.ts` re-implements slot filling for previews.

So a User cannot shape their own team's way of working, a new built-in style
touches six places in two languages, and the web preview can drift from what
dispatch actually does. Slots are inferred from roles through a fallback chain
(reviewer → tester → lead → anyone) with no way to pin a member, and a missing
reviewer silently degrades the round to Solo.

A person meets a round only at its edges: a blocked round result becomes a
Wait, `acceptancePolicy: "human"` sends a finished task to `review`, and a
Permission Prompt pauses a live run. Nothing lets a person approve a plan or
a build mid-round, before the next agent spends a turn on it.

## Decision

### A style is a template compiled by one compiler

A style is a bounded list of steps:

```jsonc
{
  "steps": [
    { "id": "spec",   "who": { "role": "planner" },   "mode": "action" },
    { "id": "build",  "who": { "agentId": "agt_…" },  "mode": "action", "after": ["spec"] },
    { "id": "qa",     "who": { "role": "tester" },    "mode": "action", "after": ["build"], "required": false },
    { "id": "review", "who": { "role": "reviewer" },  "mode": "review", "after": ["qa"], "onFindings": "build" }
  ],
  "maxRepairs": 2
}
```

One compiler turns a template plus a roster into the round's assignments and
work graph; `create_round_manifest` and every gate after it are unchanged.
`who` selects by role (with ADR-021's precedence: membership role over agent
default), by a pinned member, or — see below — a person.

Template validation is a pure rule in `collaboration/` listed in the layering
test's `POLICY_MODULES`. A template must be acyclic and at most eight steps,
have at least one `action` step, end in exactly one result-owning step, place
every `review` step after an `action` step, point `onFindings` only at an
earlier step, and keep `maxRepairs` within `MAX_REPAIRS`. A `who` that names a
member who has left the team, or a role nobody fills, is a validation error at
save and a dispatch error at run — never a silent fallback. The Solo fallback
stays only for the built-in Build → Review on a one-member team, recorded as
`styleFallbackFrom` as today.

Build → Review and Pipeline become built-in templates. Lead-led stays a
built-in whose first step is the lead's plan, which may rewrite the steps after
it (the existing `lead_plan` compile); custom templates are static graphs.

The round freezes the whole compiled template in its team snapshot, not just a
style name, so retries, history labels, and in-flight rounds survive a later
edit. Retry keys include the template revision.

Templates live on the team (`collaborationTemplate`, selected as "Custom"
beside the built-ins). There is no shared template library until a User needs
one. The web keeps its synchronous preview (it re-renders on every edit of an
unsaved team form), but cannot drift: the backend writes what dispatch really
fills for a matrix of rosters to `backend/tests/unit/collaboration_style_previews.json`,
and the web test checks `previewSlots` against it. Custom templates will need
the preview to compile the template too; that is the point to move it behind a
backend endpoint.

### A person can be a step: approve

A step with `"who": { "human": "owner" | "assignee" }` and `"mode": "approve"`
is a checkpoint. When the round reaches it, the conductor does not dispatch a
daemon run: the run request closes its segment and parks the task with a Wait
of kind `approval`, whose `questionId` is derived from the run request and the
step index (so a retried finalization writes the same Wait). No computer
reservation is held while the person thinks. Their Answer resumes the round as
a continuation at the next step, using the same mechanism a teammate question
uses to resume its requester (`QUESTION_RESUME` in `collaboration/work.py`).

The person answers with one of:

- **Approve** — the round continues at the next step.
- **Request changes** — the note becomes findings routed to the step's
  `onFindings` target, which must be an earlier `action` step. These reruns
  spend a separate, small human-requested budget, not the agents' repair
  budget: a person is already in the loop, so there is no runaway to bound.
- **Mark done** — the existing decision; it closes the task as accepted.

Only a login session or the browser UI token may answer (the decisions route's
actor rule); a node token never can. Opening the Wait notifies the named
person through `notifications/rules.py`. A thread without a task waits the
same way, through `waitingSessionId`.

`acceptancePolicy: "human"` is the trailing approve step written as a task
setting. It keeps its meaning; a template whose last step is an approve step
for the owner is equivalent, and the compiler treats them as one rule so a
task cannot be gated twice.

A person is never a team member. Members are Logical Agents placed on the
team's Computer (`teams/computer.py`); a person has no Placement. A human step
names a person relative to the work (the task's owner or assignee), so it
needs no roster or placement change.

### Rollout

1. Express Build → Review and Pipeline as templates through the one compiler,
   with parity tests that the compiled assignments are identical to today's,
   and pin the web preview to dispatch. Done: `collaboration/templates.py`; the
   pin found the preview ordering a lead after a same-stage member in Pipeline.
2. Approve steps as toggles on the built-ins ("Approve the plan" in Lead-led,
   "Approve before review" in Build → Review), and fold human acceptance into
   the same rule. Done for Build → Review and Pipeline as one team setting,
   `humanApproval`, holding the turn that closes the round. Lead-led (whose
   plan recompiles the steps) and folding `acceptancePolicy: "human"` are not
   done yet. A round with no task runs straight through: its Wait would have
   nothing to resume.
   Approval closeout is retried after an interrupted park, including when the
   thread completed before its resume index was saved. Terminal-request
   retention preserves the request named by an outstanding approval Wait;
   answering, marking done, or deleting the task releases that protection.
   Opening the Wait writes an `approval_requested` notification with the task
   change. Its question id deduplicates delivery per recipient, and the inbox
   opens the thread where the person can answer.
3. Custom per-team templates with an editor: ordered steps, who (role, member,
   or a person), mode, required, and repair target.

## Consequences

- Adding a built-in style is a template, not a branch across six modules.
- The daemon protocol does not change: a human step never reaches a daemon.
- A round can now park mid-sequence. `backend/tests/unit/test_execution_escape.py`
  must cover the `approval` Wait so every parked round keeps a way out.
- A person can only approve or redirect in this design. A person who
  *contributes* work (for example dropping files into the workspace before the
  builder runs) needs a daemon workspace-write capability and is left to a
  later decision.
- When templates ship, `CONTEXT.md` gains entries for the style template and
  the approval Wait.
