# Relay design context

The active direction is **Cool Mist (C)**, selected on 2026-11-10.

[Relay Design System](docs/design-system.md) is the canonical design
specification for palette, geometry, elevation, typography and interaction.
The executable source of truth is `web/src/styles/tokens/`.

This entry point adds no separate token definitions or competing rules.
The refinement preserves workflows, layout and semantic status meanings.
Typography is Space Grotesk for every interface role and Space Mono for code
(self-hosted, Latin subsets; adopted 2026-11-22), on one 14px reading rung —
see `web/src/styles/tokens/palette.css`. The signed-in application is an
Operate surface; the landing page remains Persuade. The [concept preview](docs/design-options/soft-directions.html)
loads production tokens for the selected C variant.
