# Unified Team Workflows

## Model and execution

A Team owns its roster and a default Workflow selection. A Workflow is either
one of the immutable predefined role-based processes (`preset:build_review`,
`preset:pipeline`, `preset:lead_led`) or a Team-owned custom step definition.
A Run freezes the selected definition and its resolved participants.

Predefined Workflows use the existing role compiler and collaboration policies;
custom Workflows use the existing sequential step runtime. Both are resolved
from one selection contract. Lead-led keeps dynamic delegation, and Build →
Review keeps its evidence and repair rules. These execution strategies are
internal details, not separate user settings.

Selection order: explicit run selection, Task/Automation selection, Team
default, predefined Build → Review. Legacy style fields remain compatibility
aliases. Historical snapshots are not rewritten. Custom Workflows retain their
Project scope; an incompatible default fails closed rather than silently
running a different process. A selected default cannot be deleted or disabled
until the Team selects another default.

## Implementation sequence

1. Add the predefined catalog, strict IDs, default/override resolution, and
   legacy adapters. Test precedence, unknown selections, frozen snapshots,
   and membership/Project refusal.
2. Persist Team defaults and expose the combined catalog. Route explicit and
   inherited selections consistently for manual, scheduled, and Automation
   execution. Keep gate/retry/owner and execution-reservation contracts.
3. Replace separate collaboration and workflow selectors with one Workflow
   selector in Team settings, Task/Automation forms, and the composer.
   Keep role previews and custom step editing; update translations and glossary.
4. Run focused regressions first, then broader backend/TypeScript/React checks,
   type/layering/lint checks, production export and desktop/phone inspection.
   Record actual RED/GREEN evidence and coverage.

## Journeys and guarantees

- An existing Team retains its behavior through a predefined Workflow default.
- A person can select each predefined Workflow and see the same role-based
  assignment and Lead-led delegation semantics as before.
- A Project Task inherits a custom Team default or explicitly overrides it
  with a predefined Workflow, including when the scheduler or an Automation
  starts it. Changing the Team default does not alter an existing Run.
- Invalid, foreign, disabled, or out-of-Project custom selections never dispatch
  ordinary Team work as a fallback.
- New forms save workflow selections, with no separate collaboration setting.

No schema migration is needed: defaults and selections use existing snapshots
and event records. New code continues to read old style fields. Older builds
cannot safely interpret newly selected custom Workflows; forward fixes remain
the rollback policy described in the Team Workflows guide.
