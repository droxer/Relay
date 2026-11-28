# ADR-027: Standalone Tasks select user-owned Workflows

## Status

Accepted. Standalone Tasks and Automations select a Workflow in place of a
Team. The standalone interface and legacy conversion implement that decision.
Project Tasks and Project Workflows keep their existing behavior.

## Decision

Extend the existing Workflow aggregate with a third immutable scope: a User's
Computer. Such a definition has `computerId` and no non-null `projectId` or
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

The Workforce navigation group contains Agents and Workflows. The standalone
Workflow page replaces Team configuration. `/teams` and `/teams/{id}` links
canonicalize to `/workflows` and `/workflows/{id}`. A standalone Task chooses
an Agent or a Workflow. Selecting a Workflow supplies its Computer when the
Task has no binding.

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

### Legacy conversion

After schema 0136, startup repairs copy eligible standalone Team defaults and
Team-owned definitions into Computer-scoped Workflows. Keeping a separate
Team configuration would preserve the duplicate roster/process concepts that
the owner asked to replace. The repair instead records the participants in
the reusable Workflow and leaves legacy Team records available for history.

Custom copies preserve ordered steps and approval gates. Build → Review and
Lead-led copies keep `kind: "predefined"` with their saved Lead, members,
roles, acceptance criteria, and human approval policy. Expanding these
processes into fixed steps would change their role-based execution. Their
configuration is immutable through the custom-step API. The owner can rename,
enable, disable, or delete them.

The Task's explicit Workflow takes precedence over its collaboration-style
override, then the Team default. The repair atomically records its Workflow
and Computer through Task events. The first imported default reuses the Team
ID when available so old detail links resolve. Other copies use deterministic
UUIDv5 IDs. Imports retain source IDs and preserve owner edits on later runs.

Invalid or ambiguous records remain unchanged and produce a skip reason with
the record ID. A refused Team retains its original Lead and members so a later
startup cannot silently migrate a different process. Active dispatch claims
and dedicated custom Workflow runs defer conversion. Existing ordinary Team
rounds finish from their frozen manifests. The repair creates no runs and
preserves historical events, original definitions, and Project-scoped data.
`RELAY_STARTUP_REPAIRS=0` skips the repair. It is separate from schema upgrade.

## Consequences

- One canonical Workflow store and event log serve all existing and new scopes.
- Standalone choices use `scope=standalone`; Project choice queries keep their
  existing semantics. Names are unique per owner and Computer.
- Legacy Team records and APIs remain compatibility contracts. Standalone
  users manage Workflows without another roster configuration.
- Deploy the backend that understands saved predefined Workflows before
  enabling the repair. Downgrading schema 0135 still refuses while standalone
  definitions exist. Reverting the UI does not undo migrated Task events.
- Backend tests cover independent Task execution, approval, retry, cancellation,
  restart, frozen definitions, scope rejection, and migration behavior.
  Verification of the complete browser suite remains separate from this
  architecture decision.
