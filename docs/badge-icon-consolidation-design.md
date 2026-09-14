# Badge and icon consolidation

Date: 2026-09-15
Status: approved, not yet implemented

## Problem

The web UI's badge and icon vocabulary was reviewed for modernity and clarity.
The review found that neither is dated. The icon layer is in good shape, and
most of the badge layer has already been consolidated onto the `Badge`
primitive. What remains is a small number of surfaces that still draw their own
chip, one type role spelled out by hand, one file that bypasses the icon module,
and one inconsistency inside the `Badge` primitive itself.

This spec covers that remainder. It deliberately does not redesign the badge
language: the chosen direction keeps the outlined chip and tunes it.

## Current state

Three modules own the vocabulary today:

- `web/src/components/ui/badge.tsx` — the `Badge` primitive. Five tone variants
  (`neutral`, `success`, `info`, `warning`, `danger`) plus a `state` variant
  that supplies chrome without an opinion about colour, for surfaces whose tone
  scale is richer than the five semantic ones.
- `web/src/components/StateMark.tsx` — the tone-to-shape grammar
  (`solid` / `live` / `ring` / `dashed` / `muted`). Shape carries the class of a
  state, colour carries its tone.
- `web/src/components/icons.tsx` — the curated lucide wrapper. Tokenised stroke
  (`ICON_STROKE` 1.75, `ICON_STROKE_LARGE` 1.25), tokenised sizes
  (`ICON.xs`…`ICON.hero`), and a separate `AVATAR` scale. Semantic exports only,
  so no caller knows which lucide glyph was chosen.

Ten component files consume `Badge`. There are zero hardcoded `size={…}` values
at any icon call site in the application.

The following classes have already been migrated onto `Badge` and retain only
legitimate per-surface residue (height, fill, accent). **They are out of scope
and must not be touched:**

`.adm-agent-chip`, `.adm-node-chip`, `.adm-fleet-chip`, `.adm-computer-chip`,
`.adm-node-card-employee-badge`, `.backlog-filter-chip`,
`.agents-roster-row-badge`, `.artifacts-empty-tag`, `.routine-state`,
`.adm-copy-pill`, `.adm-presence-pill`.

## Non-goals

- **No redesign of the badge visual language.** The outlined chip stays. The
  primitive's geometry (6px control radius, 8px inline pad, 12px caption type,
  `ICON.xs` glyph slot) is already correct and argued for in its own comments,
  and is not up for revision. Phase 2 tunes one property of it; that is the
  full extent of the visual change to the primitive.
- **No change to `StateMark`.** The tone-to-shape grammar is sound.
- **No icon restyle.** Stroke, size rungs, and semantic naming are already
  tokenised and disciplined.
- **No `0.5px` → hairline sweep.** Roughly 240 literal `0.5px` borders across 43
  stylesheets coexist with a `border-hairline` token. This is a real consistency
  problem, but it is an app-wide sweep that would triple this diff and bury the
  badge changes. It gets its own follow-up spec.
- **`.priority-badge` stays bespoke.** Its three ascending signal bars are a
  deliberate departure: priority is a rank, not a status, and the bars are the
  point. It correctly uses `Badge variant="state"` for chrome already.
- **`.artifact-kind-tag` stays as-is.** It renders bare text with no chip chrome
  at all. It was never a badge; making it one would add a box the design did not
  ask for.

## Phase 1 — consolidate

Migrating a bespoke chip onto the primitive **will** change how it looks,
wherever it previously disagreed with the primitive. `.adm-agent-inventory-pill`
sets `--fs-2` (13px) where `Badge` uses 12px caption type, and all three chips
draw a `0.5px` border where the primitive draws a token hairline. Those deltas
are the point of the work, not a side effect.

The acceptance criterion is therefore **no unexplained delta**: every visual
difference after this phase must be attributable to a specific property the
primitive owns and the chip was overriding. A difference nobody can trace to
such a property is a defect.

Item 1b is the one item expected to produce no delta at all: it substitutes a
role for an identical quadruple. Item 1c *does* produce a delta — SideNav glyphs
move from lucide's default stroke 2 to the app's 1.75, which is the entire
reason for doing it. Item 1d produces a delta only for a file that turns out to
be duplicating an existing export.

### 1a. Three bespoke chips adopt `Badge`

Each currently redeclares geometry the primitive already owns. After migration
each keeps only its accent and any genuine layout residue.

| Class | Call site | Privately redeclares | Target |
|---|---|---|---|
| `.adm-agent-inventory-pill` | `components/admin/ManageExecutorsDrawer.tsx` | `--r-2`, `0.5px` border, own padding, raw `--fs-2` | `<Badge variant="neutral">` + residual `max-width` / ellipsis |
| `.adm-dash-empty-tag` | `components/admin/dashboard/TokenUsageChart.tsx` | `--r-2`, `0.5px` border, own padding, own micro type | `<Badge variant="neutral">` |
| `.pref-lang-badge` | `components/PreferencesPanel.tsx` | own radius, border, fill, raw `--fs-1`, fixed `2.25rem × 1.375rem` box | `<Badge variant="neutral">` |

`.pref-lang-badge` needs one extra decision. Its fixed pixel box exists so that
two- and three-letter language codes align in a column. Replace it with a
`min-width` expressed on the `ch` grid and let height come from the primitive's
padding, so alignment survives without pinning the chip's geometry.

### 1b. `.agent-placement-badge` takes a type role

It is already on `Badge`, but assembles its label type by hand:

```css
font-size: var(--fs-2);
font-weight: 400;
line-height: var(--leading-snug);
letter-spacing: var(--track-0);
```

That quadruple is the *default-scope* shape of `--type-body-sm`, so substitute
the role. It is **not** a zero-delta substitution, and the original draft of
this spec wrongly claimed it was:

- The compact scope restates `--type-body-sm` one rung down (`--fs-2` → `--fs-1`).
  The hardcoded rule held 13px there while the text around it dropped to 12px.
- `--track-0` is `0`; `--track-body-sm` is `-0.01em` in the default scope.

Both deltas are the role doing what the role does, and nothing in the rule or
its history justified this badge opting out of the compact scale. Taking the
role is therefore a small deliberate change, and the capture review should
expect it rather than flag it.

### 1c. `SideNav.tsx` routes through `icons.tsx`

`components/SideNav.tsx` is the only file in the app importing `lucide-react`
directly. Glyphs reached that way ship lucide's default `strokeWidth` of 2
alongside the app's 1.75, which is visible where a SideNav glyph sits near any
other chrome icon. Add the needed semantic exports to `icons.tsx` and import
from there.

`icons.tsx` already documents itself as the only module allowed to import
lucide. This restores that invariant rather than introducing it.

### 1d. Inline-`<svg>` audit

Eight files contain inline `<svg>`. This item produces a **written verdict per
file**, not a presumed migration. Expected outcome, to be confirmed rather than
assumed:

- Legitimately bespoke: `RelayMark.tsx`, `AgentMark.tsx`, `IdentityMark.tsx`
  (brand and identity marks, filled not stroked), `dashboard/TokenUsageChart.tsx`
  and `dashboard/ActivityChart.tsx` (data-driven chart geometry).
- Warrant a look: `PreferencesPanel.tsx`, `LoginScreen.tsx`,
  `admin/ChannelPrimitives.tsx`.

Any file whose inline SVG duplicates a glyph `icons.tsx` already exports should
adopt the export. Any that stays bespoke gets a one-line comment saying why.

## Phase 2 — tune the primitive

### 2a. Unify the tone border ratio

`badge.tsx` currently sets four tone borders at two arbitrary ratios:

```
success: border-success/35
info:    border-info/30
warning: border-warning/30
danger:  border-danger/35
```

Four tones, two ratios, no stated reason for the split. This is drift inside the
primitive itself, and it is why the four tones read as two pairs rather than one
family. Unify to a single ratio, and record the chosen value's reasoning in the
variant table comment alongside the existing notes.

Choosing the value is an implementation decision to be made against the specimen
page with all four tones rendered together, in both themes. The requirement is
that one ratio serves all four, not that a particular number is used.

### 2b. Retire the presence-pill height literal — NOT DONE, deliberately

This item was specified on a false assumption and was dropped during
implementation. Recorded here rather than deleted, because the underlying
finding is real and someone will otherwise rediscover it.

The plan was to replace `.adm-presence-pill`'s `height: 20px` with a
control-height token. There is no such token: `--control-h` bottoms out at
`--control-h-2xs: 24px`.

Nor is the literal redundant. `Badge`'s natural height is its `py-0.5` padding
plus its `text-micro` line box; at `--leading-caps: 1.33` that computes to
roughly 22px. The 20px pin is actively *compressing* the primitive, not
restating it.

Five rules across `admin-v2-nodes.css` and `admin-v2-channels.css` pin
`height: 20px` for this reason. The real finding is that **`Badge` has no
compact height rung**, and five surfaces each worked around its absence
privately. Fixing that means either adding a rung to the control scale or
giving `Badge` a size variant — both of which change badge heights across those
five surfaces. That is redrawing, not tuning, and direction A explicitly
excluded it. It belongs with the follow-up spec.

Phase 2 is therefore item 2a alone. Direction A asked for tuning, not
redrawing, and this is what that constraint costs.

## Testing

The verification surface is the existing design-system specimen page at
`web/src/app/dev/design-system/specimen.tsx`, which already imports `Badge`.

1. **Extend the specimen** to render every `Badge` variant plus the three
   migrated chips side by side, in both light and dark themes.
2. **Phase 1 is verified by measurement, not by screenshot.** This replaces the
   before/after capture the spec originally called for, which would have had a
   human eyeballing pixels for a property-level claim.

   `web/e2e/design-consistency.spec.ts` gained
   *"consolidated chips keep the Badge geometry"*: it reads `borderRadius`,
   `borderTopWidth`, all four paddings, `fontSize`, `fontWeight`, `lineHeight`
   and `height` off each migrated chip and off a reference `Badge` on the
   specimen, and asserts they are equal. It compares against the reference
   rather than against literals, so it follows the primitive when the primitive
   is tuned instead of pinning today's values and having to be rewritten by the
   next Phase 2.

   This is a stronger check than a capture: it states exactly which properties
   must not diverge and fails loudly on the one that does.
3. **Phase 2 is verified by inspection** of the four tones rendered together on
   the specimen, in both themes.
4. **The existing `web/tests/*` suite must stay green.** It covers component
   logic that this work does not change; CSS-only changes do not reward new unit
   tests, so none are added.

## Sequencing

Phase 1 lands before Phase 2, on one branch, as separate commits.

The ordering is the point of the approach: once every chip routes through
`Badge`, the Phase 2 tune is a single-file change that every surface inherits,
and it can be reviewed and reverted on its own. Doing the tune first would leave
the app visibly inconsistent across the whole middle of the project and would
entangle "move to the primitive" with "adopt the new look" in every commit,
making any regression ambiguous in origin.

## Risks

- **`.pref-lang-badge` alignment.** Its fixed box is load-bearing for column
  alignment in the preferences list. The `ch`-grid `min-width` replacement must
  be checked against the longest language code actually shipped, not a
  representative one.
- **SideNav glyph substitution.** Routing through `icons.tsx` may change which
  lucide picture a given nav item uses if an existing semantic export was chosen
  for a different meaning. Each substitution needs to be a deliberate match, not
  a name-similarity match.
- **Specimen coverage is not surface coverage.** The specimen proves the
  primitive is right; it does not prove each migrated call site kept its residue.
  Per-surface captures in step 2 are what cover that, and they are not optional.
