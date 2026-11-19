# Task Kanban lifecycle

A task is one deliverable. Agent sessions and rounds are attempts to produce that
deliverable; ending an attempt does not necessarily finish the task.

## Workflow and policies

| Board stage | API representation | Policy |
| --- | --- | --- |
| Backlog | `status=backlog` | Uncommitted demand. Assignment may be recorded without starting work. |
| Ready | `status=assigned` | Selected or admitted demand waiting for an agent to start. The scheduler pulls when runtime and WIP capacity permit. |
| Queued | `status=queued` | Waiting for user WIP or Computer execution capacity. The scheduler retries automatically. A first start reserves WIP when admitted. |
| In progress | `workflowStage=running` | An agent has started executing. Human waits remain on this stage until review or another queued continuation. |
| Review | `workflowStage=review` | Work awaits acceptance by a person with access to the task. Entering Review frees the WIP slot. Rework requires capacity again. |
| Done | `status=done` | Accepted delivery. Automatic acceptance frees the WIP slot at this stage. |
| Cancelled | `status=cancelled` | Abandoned work; preserves history and frees WIP after execution is safely settled. Does not count as delivered work. |

The existing API status identifiers remain valid for reads; `queued` and `cancelled` are additional states. `blocked` and
`waiting_for_human` are conditions displayed within the preserved workflow stage,
not separate board columns. Consumers should group by `workflowStage`.

New tasks enter Backlog or Ready; clients cannot create tasks already running,
waiting, in review, or done. A drag to In progress invokes `POST /tasks/{id}/runs`.
PATCH cannot fabricate execution. Active task execution prevents manual stage
changes; stopping a run remains an explicit thread operation.

New creation events explicitly record `acceptancePolicy=human`. Successful agent
work goes to Review, and a person accepts it with `PATCH {"status":"done"}`.
`acceptancePolicy=automatic` is an explicit alternative that accepts the runtime's
completion verdict. Policy can be changed before work starts; routine templates
can change policy for future occurrences. Existing creation events without a
policy retain automatic acceptance to avoid changing historical intent.

Blocking requires `blockerReason` (1–2000 characters). Status events record the
actor, and projections retain the reason, responsible actor, blocking timestamp,
and prior status. `PATCH {"action":"unblock"}` restores the recorded state.
Previously executing work returns to human waiting, not a false running state;
queueing more work is a separate action. A blocked review returns to Review.

A started task cannot return to uncommitted Backlog. Rework and reopening use
Ready's API status (`assigned`) while remaining in the In progress board stage.
The original start time is retained. Create another task for a new deliverable
rather than reopening accepted work with new scope.

## WIP and scheduling

Tasks in a Project workspace can execute concurrently within the user's task
limit and the Computer's execution limits. In other shared workspaces, the
current Thread's queued follow-up messages take priority over Tasks already
waiting for that workspace. The workspace remains with that Thread
through its admitted follow-up rounds until the queue drains. Paused queues,
archived or deleting Threads, and queues held for human input or approval do
not reserve this priority (an explicit send overrides the human-wait gate).
Other workspaces can continue independently. An execution already delivered
or being dispatched is not interrupted by a later queued message.

The pure policy lives in `backend/relay/core/workspace_scheduling.py`:
`preferred_thread_id` selects the Thread that retains priority, and
`workspace_is_contended` applies that priority alongside active execution and
FIFO waiting order. `persistence/daemon/workspace_queue.py` reads the durable
facts; admission, delivery, and database dispatch claims use the shared policy.

The Admin control panel sets each user's **Concurrent task limit** (1–100),
default **5**. It limits admitted work, including tasks blocked during execution.
Entering Review releases the slot. Clearing the per-user `maxConcurrentTasks`
override restores the server default (`RELAY_TASK_WIP_LIMIT`, a positive integer
defaulting to 5).
The effective value is read from the database at admission, so changes apply
across backend replicas without restarting them. Lowering a user's limit does
not cancel admitted tasks. Scope is the task's human assignee, falling back to
its owner; tasks with neither share an
unowned scope. All backend replicas must use the same configured fallback limit.

The first accepted execution claim reserves a slot while the task stays in Ready.
The daemon moves it to In progress when an agent starts. Legacy event histories
also recognize running and human-waiting states as evidence of admission.
Unadmitted Ready and Queued inventory and routine templates use no slot. A task
retains its slot during blocked execution, waits for input during execution, and
queued continuations. Entering Review releases capacity, including when acceptance
is later put on hold. Returning a task for rework, reopening a finished task, or
moving admitted work to another user requires capacity.

A capacity preflight queues new work before allocating a thread; the final check
remains atomic to cover concurrent starts. Manual starts, scheduled starts, and
task-scoped thread recovery share the event store admission check. PostgreSQL
serializes count-and-admit with a transaction advisory lock. SQLite acquires its
writer lock before reading snapshots. Admission counts occupied slots from task
snapshots for the affected user. Execution runs through daemon commands.

At capacity, tasks enter `status=queued`, `workflowStage=queued`, with
`dispatch.code=task_wip_limit` and `dispatch.state=queued`. This is a capacity wait,
not a failed execution. The scheduler retries admission automatically. Genuine
dispatch failures still block after the first attempt and require manual retry.
Refused new threads are closed without sending a daemon command. Existing conversations remain
available. Lowering a limit does not cancel existing work; continuations can finish
it while new starts wait.

Computer execution capacity is separate from task WIP. The daemon advertises
`maxConcurrentRuns` (default 5, configured with
`RELAY_DAEMON_MAX_CONCURRENT_RUNS`), shared by every Logical Agent and Agent
Runtime on that Computer. A full execution pool or durable run queue records
`dispatch.code=capacity_exhausted` and leaves the Task queued for automatic
retry. Durable admissions are bounded to twice the Computer's run capacity.
The board explains Computer capacity waits separately from user WIP waits.
Runs sharing a non-Project workspace execute one at a time. Team participants
within one run execute sequentially on one Computer. Independent workspaces
can run the same Logical Agent concurrently. Direct Thread work without a linked Task
uses Computer capacity but does not acquire a task WIP slot.

Run `npm run test:e2e:concurrency -w web` to exercise the browser, a real local
Python backend, and a real daemon against a disposable SQLite database. The
test substitutes only the agent CLI with a controlled child process: two
runs of one Logical Agent execute in independent Project workspaces, a third
queues, and cancelling one through the UI proves child exit and automatically
starts the waiting Task. It checks both the queued explanation and its removal.
This suite runs in CI alongside the PostgreSQL reservation tests.

Queue precedence is high/normal/low priority, earliest due date (undated last),
oldest creation time, then task ID. The board's default order matches the scheduler.
An explicit display sort does not change dispatch order.

## Flow measurements

The board uses event-derived `startedAt` and `finishedAt`, not `updatedAt`:

- Board WIP: all started, unfinished tasks in the accessible task list, including work awaiting acceptance.
- Oldest work-item age: elapsed days since the oldest unfinished task started.
- Throughput: tasks currently Done whose acceptance occurred in the last 30 days.
- Average cycle time: elapsed time from first start through acceptance, including waits.
- SLE: the 85th percentile cycle time for the last 30 days when at least 20 samples
  exist. Until then, the displayed **8-day initial estimate** is explicitly labeled.

Project activity counts only that project. A separate “Your WIP across projects”
reading uses the server's `flowUsage: { userId, occupied }`, scoped to the signed-in
user (including administrators), and links to that user's tasks across projects.
It counts before list pagination and never presents project WIP as global capacity.

Metrics use the full accessible list before board filters and pagination; routine
templates are excluded. Deleted tasks are excluded from this operational board,
so these figures are not an immutable historical delivery ledger. Reopened tasks
leave the completed sample until accepted again. An administrator sees aggregates
across accessible users, while the displayed WIP limit remains per user.

## Existing tasks and rollout

Migration `20260913_0069` rebuilds flow fields in existing task snapshots from their
authoritative events. It does not rewrite task events, start agents, change
assignments, or invent historical timestamps. It processes one task history at a
time. Downgrade removes only the added snapshot fields.

Migration `20260916_0074` replays the workflow-stage projection so executions
claimed before an agent actually started return to Ready. It leaves task events,
execution ownership, WIP admission timestamps, and run requests unchanged.

Stop backend writers, run `make backend-migrate` against the intended database,
then restart the backend and deploy the matching web build. Pause writers during
this projection migration so replay cannot overwrite a concurrent snapshot.
Tasks already above the configured WIP limit may finish; new work waits.

Review blocked and aging work first, review pending deliveries next, and replenish
Ready as capacity becomes available. Use the measured cycle times to revise the
initial SLE and the WIP limit. Kanban does not require a sprint boundary.

## Cancelling work and deploying the new states

`PATCH /tasks/{id}` with `status=cancelled` abandons a task without deleting its
history. The status event records the actor, and replay derives `cancelledAt`.
`startedAt` remains unchanged; `finishedAt` stays reserved for accepted delivery.
Cancellation refuses active dispatch claims, live runs, pending finalization,
and linked executions requiring reconciliation, even when the thread already
reads completed or failed. Stop the run and await exit evidence, or reconcile
it through the existing human assertion path, before cancelling the task.
Automations are paused rather than cancelled. Accepted tasks cannot be cancelled.

A cancelled task must explicitly reopen to Ready before it can run again;
started tasks reacquire WIP on reopening. Cancelled prerequisites remain
unsatisfied until explicitly completed or removed; cancellation is not delivery.

Migration `20261104_0111` extends the dispatch index to Ready and Queued tasks.
PostgreSQL builds the replacement concurrently in an autocommit block before
removing the old index; SQLite replaces it within the migration transaction.
Downgrade restores the Ready-only index and retains event history. Deploy matching
backend and web readers together; older readers do not understand the new states.
The startup repair requeues only old, unadmitted WIP-refusal blocks, with no
execution owner or active claim. It preserves human blocks and execution failures.
`RELAY_STARTUP_REPAIRS=0` disables this repair with the other startup repairs.

Migration `20261104_0112` adds nullable `users.max_concurrent_tasks`. Existing
users inherit the default; no task histories or admitted executions change.
Downgrade removes the user overrides. Run both migrations before deploying the
matching backend. The user list/create/PATCH API exposes `maxConcurrentTasks`
and `effectiveMaxConcurrentTasks`; only administrators can change the setting.
