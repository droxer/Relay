# ADR-025: Independent Project Workflows with optional Team assignment

## Status

Accepted. Extends ADR-016 and ADR-021 for explicit custom processes. Supersedes
the Team-owned definition model in the earlier Team Workflows guide. ADR-021's
predefined Team role compilation and execution policies remain unchanged.

## Context

Keeping custom definitions inside a Team made a process depend on that Team's
lifecycle. A Project with Agents but no Team could not run a saved process, and
sharing it with another Team required a copy. A global custom Team default also
changed work in unrelated Projects despite the definition's single Project scope.

## Decision

A custom Workflow is an independent, owner-managed Project aggregate. Teams
reference it through links; removing a Team/link preserves the definition.
Project steps keep explicit Agent assignments. An optional Team must contain
those Agents and use the Project's Computer; linking does not remap participants.
Project-wide reusable templates and role slots are deferred rather than adding
another binding model during extraction.

Canonical `/workflows` APIs manage definitions and start Project Threads without
a synthetic Team or lead. Tasks and Automation occurrences may explicitly select
a Workflow without a Team. Predefined processes still need Team roles. Team
custom defaults are keyed by Project, so they do not change unrelated work.

Definitions have independent versioned events and projections. Migration 0129
extracts stable IDs/scopes/steps/timestamps and materializes Team links. Legacy
Team APIs adapt to these records; they do not retain writable nested definitions.
Old defaults remain compatible until explicitly changed. Existing run ledgers
are not rewritten. New ledgers freeze a `workflowSnapshot` and retain the
`teamSnapshot` wire alias so daemon/client rollout stays compatible.

Every step still needs live Project authorization, enabled Agents, and Placement.
A run explicitly naming a Team additionally needs live Team membership. A frozen
definition records what runs; it never grants access. Approval, request replay,
Task generations, execution reservations, and daemon execution retain their
existing authorities.

## Consequences

- Zero-Team Projects can manage and execute saved processes; multiple eligible
  Teams share a definition without copying or owning it.
- The UI has one editor in Project Workflows and assignment/default controls
  in Teams. Explicit incompatible selections require repair instead of fallback.
- Existing duplicate names are preserved during import; new creates/renames
  enforce Project-local uniqueness under a Project resource lock.
- Disabling/deleting a referenced default requires clearing it first. Deletion
  preserves frozen runs and tombstones the definition for future selection.
- Downgrade is refused once definitions exist: standalone Project definitions cannot fit
  the former Team model without loss. Recovery after rollout uses a forward fix.
