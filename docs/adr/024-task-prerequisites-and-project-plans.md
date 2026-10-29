# ADR-024: Task prerequisites, and project plans that agents propose and owners apply

## Status

Accepted. Extends ADR-016 and ADR-022.

## Context

A project's tasks had no order. The scheduler dispatched every `assigned`
task by priority and due date, so "build after design" held only if a person
released the work by hand. Ordering existed only inside one round (a lead's
plan, `dependsOnWorkItemIds`), and it vanished with the round.

The question was whether a dedicated planner — an agent that owns the
backlog — should organize projects. That would make an agent a second source
of truth for task state: its edits would bypass the event log's guarantees,
its mistakes would be hard to audit, and it would break the rule every other
project change follows (ADR-022: agents propose, owners apply).

## Decision

**Ordering is a backend rule.** A task may name prerequisites: tasks in the
same project that must be done before it may run. The whole set rides one
`task.prerequisites_set` event (`PUT /tasks/{id}/prerequisites`), and the
`task_prerequisites` table materializes it for the dispatch query. The store
validates a set under its write lock — same project, no automations, at most
ten, no cycle (serialized per project on Postgres) — with the pure rules in
`backend/relay/tasks/prerequisites.py`.

**Waiting is derived, never a status.** `waitingOn` is computed on read and at
dispatch: a prerequisite releases its dependents only when `done`; a deleted
one counts as satisfied, so nothing waits on work that no longer exists. A
waiting task keeps its status (`assigned` stays `assigned`), the dispatch
query skips it, and a manual start answers 409 `task_prerequisites_open`.
It dispatches on the first scheduler tick after its last prerequisite is done.

**Planning is a run the project's lead does, not a new actor.** A setup draft
gains a `mode`: `setup` drafts the crew and first tasks, `plan` drafts only the
next tasks for a project that has its crew (the lead drafts it; else a
`planner`). Proposed tasks carry a `key` and `after` (keys of earlier tasks,
so a proposal is acyclic by construction) or `afterTaskIds` (existing open
tasks the plan round was shown). Applying is `POST /projects/{id}/setup/tasks`:
it creates the kept tasks through the ordinary task path, sets their
prerequisites, and only then — with `queue: true` — makes them ready, so the
scheduler never sees a task before it knows what that task waits for. Each
applied key is recorded on the setup (`appliedTasks`), so a retried apply
creates only what is missing. Applying holds the database project row lock;
task creation, prerequisites, queueing, and the applied keys commit in one
transaction. A failed apply rolls back all of them, and concurrent backend
replicas read the applied keys under the same lock.

## Consequences

- A chain of project work runs itself in order once queued, with no agent
  holding authority over the backlog.
- A standing planner, if wanted, is an automation that starts the same plan
  run on a schedule or a task event; it still only proposes.
- Older daemons render a plan round with the setup prompt; the backend keeps
  only the proposal's tasks, so the round still yields a usable plan.
- Prerequisites stay within one project; cross-project ordering and
  parent/subtask hierarchies are out of scope.

## Update: user-controlled task starts

Setup and plan drafting first create a task and immediately run it in a linked
thread. Applying the resulting proposal only creates backlog tasks and their
prerequisites, and closes the drafting task. Queue-on-apply is retired; the
owner starts each proposed task separately after reviewing the created tasks.
