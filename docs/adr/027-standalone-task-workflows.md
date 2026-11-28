# ADR-027: Standalone Tasks select user-owned Workflows

## Status

Accepted for the standalone definition and Task runtime foundation. The owner
requested that independent Tasks use Workflow in place of Team, excluding
Project Tasks from this redesign. Replacing the Team UI and converting legacy
Team assignments remain follow-up implementation.

## Decision

Extend the existing Workflow aggregate with a third immutable scope: a User's
Computer. Such a definition has `computerId` and neither `projectId` nor
`ownerTeamId`. This extends ADR-026's two-scope constraint without changing
existing Project- or Team-owned definitions.

An independent Task selects the definition through `assignedWorkflowId` and
names the same Computer. Its step Agents belong to the owner and have active
Placements on that Computer. No synthetic Team or Project is created. Custom
steps retain the existing ordered execution and optional approval gates.

Task dispatch resolves its durable workspace using ADR-018's rules and records
the binding with the frozen Workflow Run and execution claim in one transaction.
The definition's Computer is immutable; an existing Task binding cannot move.
Each delivered step still checks the current Agent and Placement. A frozen
definition records the process, while live state governs execution.

Standalone definitions run through the Task entry. Project direct-run and link
APIs cannot change their execution scope. Project-owned definitions retain the
existing Project paths and assignment rules. An owner may always cancel a run
when an Agent becomes unavailable.

Migration 0135 adds the nullable Computer scope and its ownership index. It
does not rewrite Team definitions, Task assignments, defaults, historical
snapshots, or in-flight runs. Downgrade refuses while standalone definitions
exist, including deleted definitions, to preserve their history.

Migration 0136 adds `assignedWorkflowId` from the Task snapshot to the dispatch
queue's partial-index predicate. The scheduler recognizes that selection as a
target even without Agent, Team or Project assignment. PostgreSQL builds the
replacement index concurrently before removing the old one; these operations
commit outside the migration transaction and support retry.

## Consequences

- One canonical Workflow store and event log serve all existing and new scopes.
- Standalone choices use `scope=standalone`; Project choice queries keep their
  existing semantics. Names are unique per owner and Computer.
- Legacy Team conversion needs a separate deterministic mapping before its UI
  can be removed. The foundation alone does not complete that replacement.
- Backend tests cover independent Task execution, approval, retry, cancellation,
  restart, frozen definitions, scope rejection and migration behavior. Browser
  integration remains part of the UI work.
