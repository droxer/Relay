# Relay Design System

<p align="center">
  <img src="../web/public/brand/relay-logo.svg" alt="Relay logo" width="360">
</p>

## Overview

The executable source of truth is `web/src/styles/tokens/`. This document
specifies Relay's current dense workspace UI. The [source-system appendix](#appendix--the-source-system)
is historical design reference, not a component specification: Relay adapts its
colors and typography but uses compact corners and flat elevation.

> **A neutral canvas carries the content; cobalt carries the action;
> shared tokens and components carry the interface.**

A near-white cloud canvas with stark white cards, a cool ink ramp, the source
system's semantic status hues, and one saturated action colour — cobalt `#0064e0` —
worn only by things you can press. The system adapts the source analysis into
a dual-register application identity. It supersedes the Fieldnotes identity
(cream canvas, olive ink, one highlighter yellow), which in turn superseded
Phosphor.

- **One action colour.** `--action` is cobalt (`#0064e0`) and it is
  **register-invariant**, down to its pressed state (`--action-hover`
  `#0457cb`, the source system's `primary-deep`). Text on the fill is always white
  (`--on-action`, 5.4:1 on the fill and 6.5:1 on the pressed state). The source
  system runs two primaries — cobalt inside the commerce flow, a black pill on
  marketing surfaces — and Relay is entirely in-product, so cobalt is the
  action on every surface, pre-auth chrome included; the black marketing pill
  has no consumer here and is deliberately not carried as a token, so there is
  no second primary to keep in step with. There is no disabled hex —
  disabled is opacity. Links are **not** `--action`: they take `--link` (the source system's meta-link blue),
  reserved for wayfinding — anchors in prose and the focus ring.
- **Status is chromatic, and still dot / border / text — never fills.**
  `--ok` `--warn` `--err` carry the source system's success / warning / critical
  hues. The published values are *badge fill* colours (white text on a
  saturated pill); Relay renders status as ink far more often than as a fill,
  so each tone is deepened or lifted until it **clears AA as small text**
  against the worst plane it can land on. The hue family is the source
  system's; the lightness is ours. `--info` is not a separate value: it aliases `--ink-3`.
- **Every ink tier that can carry text clears 4.5:1.** The bar is the worst
  plane a tier can land on — `--surface-3` in dark, `--surface-2` in light —
  because meta text sits on drawers and inset wells too. This is why the light
  ramp's calm end (`--ink-4` `#556170`) is deeper than the source system's steel
  (`#5d6c7b`, 4.34:1 against the recessed fill), and why `stone` (`#8595a4`)
  never enters the ramp at all: it is a disabled-label value, and disabled
  here is opacity.
- **Dual-first registers.** The light register is the commerce page: a
  soft-cloud canvas (`#eef1f5`) under near-white cards and stark white
  floating chrome. The source system publishes **no dark-mode token set** (see
  [Known gaps](#known-gaps-and-what-relay-did-about-them)), so the dark
  register is **derived**: `ink-deep` (`#0a1317`)
  becomes the canvas and the cloud greys invert into an elevation ladder.
  Dark is the default register (`:root`); `html[data-theme="light"]`
  overrides it.
- **Two accents, two jobs.** The source system sanctions cobalt and Oculus purple and
  nothing else. Cobalt is the action; the purple is `--live`, work an agent is
  doing *right now*. Splitting them across hues rather than across channels is
  deliberate: a pulsing blue dot beside a blue button would put "working" and
  "press me" in the same colour.
- **One sans, every job.** The source face is **Optimistic VF**, which Meta
  does not license for redistribution: it leads `--font-sans` for anyone who
  has it installed, and the vendored **IBM Plex Sans Variable** behind it is
  the face this app actually ships. Hierarchy is built from **size and
  weight** (400/500/700), never from a second face. The weight ramp is
  inverted against the usual expectation: the display tiers are 500 and the
  heaviest weight belongs to the *small* roles — button labels, badges, body
  emphasis. JetBrains Mono survives for technical text only — IDs, logs,
  code — the code role is 400 and the `.code` utility is 500, both untracked.
- **Compact geometry, flat surfaces.** Micro details use `--r-1` (4px),
  controls/tabs/badges use `--r-2` (6px), and containers use `--r-3` (8px).
  `--r-full` is reserved for true circles and capsules, including status dots
  and switch tracks. Floating surfaces use a hairline ring, without blur.
- **One ease, two speeds.** `--ease` `cubic-bezier(0, 0, 0.2, 1)` (ease-out),
  `--t-fast` 150ms, `--t-slow` 250ms — the source system's recommended band.
  Nothing
  overshoots.

The executable source is `web/src/styles/tokens/`. Review the application in
both registers when changing tokens; do not maintain a second hard-coded token
demo.

## Token architecture

Tokens live under `web/src/styles/tokens/`, imported by
`web/src/styles.css`. The three Relay files are pulled in with
`layer(relay)`; `shadcn-bridge.css` stays **unlayered** because it carries the
Tailwind `@theme` machinery:

1. **`palette.css`** — raw values: both color registers side by side, plus
   the register-invariant scales (radii, spacing, measure, type sizes,
   tracking, leading, elevation, z-index, motion, families, shell
   dimensions). This is the *only* file allowed to originate a color —
   enforced by `web/.stylelintrc.json`.
2. **`roles.css`** — the composites: the `--type-*` roles and their paired
   `--type-*-track` tokens, `--shadow-1` / `--shadow-2`, the focus contract
   (`--focus-outline` / `--focus-outline-danger` / `--focus-w` /
   `--focus-offset`), `--link` / `--link-hover`, and the `--info` alias.
3. **`shadcn-bridge.css`** — the `@theme inline` block and
   `--background` / `--primary` / etc. aliases that shadcn/ui and Tailwind
   utilities consume. Utility names (`text-ink`, `border-hairline`,
   `rounded-md`, `text-sm`) stay stable so component markup never tracks
   token renames. Note shadcn's own `--accent` / `--ring` names are its
   aliases (hover surface / outline color), which is why the action family
   is named `--action`, not `--accent`. `--ring` points at `--link`, not
   `--action`: a focused primary button must not ring in more of its own
   fill.

   The file has two halves with different rules. The **additive** colour
   aliases exist only if a component asks for them — Tailwind ships no default
   for `text-ink`, so an unused entry is dead and gets deleted. The **scale
   guards** (`--radius-*`, `--text-*`, `--spacing`) override stock Tailwind
   scales, so they are kept complete whether or not each step is used:
   deleting `--radius-xl` does not remove `rounded-xl`, it hands it back to
   Tailwind's 12px default, off the radius ramp. There is deliberately no
   named spacing scale — `p-sm` and `p-3` were the same 12px reached two ways,
   and the numeric scale is the one that maps 1:1 onto `--sp-N`.
4. **`base.css`** — html/body reset, the `:focus-visible` contract, the
   `ss01`/`ss02` feature pair, and the shared utilities (`.tnum`, `.code`,
   `.eyebrow`, `.tone-*`).

   `.tnum` and `.code` are deliberately two names, not one. `.tnum` gives
   tabular figures in the reading face — counts, timestamps, ratios, sizes.
   `.code` gives the mono face to literal strings the operator could type,
   paste, or diff — node ids, `@handles`, emails, workspace paths,
   credentials. Because `.code` supplies a family and weight rather than a full font role, a companion rule
   using the `font` shorthand resets it; those sites carry an explicit
   `.<class>.code` override.

**Naming rule:** component CSS only ever references a palette token
(`--surface-*`, `--ink-*`, `--line-*`, `--action*`,
`--ok/--warn/--err/--info`, `--live`, `--link-blue*`, `--r-*`, `--sp-*`,
`--measure*`, `--fs-*`, `--track-*`, `--font-*`, `--z-*`, `--t-*`, `--ease`)
or a role (`--type-*`, `--shadow-*`, `--focus-*`, `--link*`) — never a literal
hex/`rgb()`/`hsl()`.

**No exceptions.** `web/.stylelintrc.json` grants exactly one file-level
override — `palette.css`, which originates colour by definition. Every other
stylesheet consumes tokens outright. `login.css`, `preferences.css`, and
`artifact.css` are **not** exceptions — they consume the pinned `--dark-*` /
`--light-*` / `--paper` tokens, which is exactly why those tokens exist.

## Colors

Dark register / light register:

| Token | Dark | Light | Role |
|---|---|---|---|
| `--surface-0` | `#0a1317` | `#eef1f5` | canvas (ink-deep / soft cloud) |
| `--surface-1` | `#131c21` | `#fbfcfd` | cards, panels |
| `--surface-2` | `#1b262c` | `#e0e6ed` | fills, search, hover |
| `--surface-3` | `#22303a` | `#ffffff` | drawers, modals |
| `--ink-1` | `#ffffff` | `#0a1317` | headings, emphasis |
| `--ink-2` | `#dfe3e8` | `#1c1e21` | body |
| `--ink-3` | `#b6bec6` | `#444950` | secondary labels |
| `--ink-4` | `#a4adb6` | `#556170` | timestamps, meta, disabled |
| `--line-1` | `#2c3a43` | `#ced0d4` | structural hairline |
| `--line-2` | `#1f2b32` | `#d6dce3` | soft hairline |
| `--action` | `#0064e0` | `#0064e0` | actions, selection, brand — register-invariant |
| `--action-hover` | `#0457cb` | `#0457cb` | pressed / active — register-invariant |
| `--action-soft` | 15% soft-cobalt wash | 12% cobalt wash | selection wash, active nav |
| `--on-action` | `#ffffff` | `#ffffff` | text on the action fill |
| `--link` / `--link-hover` | `#8ab4f8` / `#b9d3fb` | `#385898` / `#0457cb` | anchors in prose, focus ring |
| `--ok` | `#4ac16a` | `#12752f` | ready, passed, done |
| `--warn` | `#fc9f30` | `#8f560f` | attention, degraded — amber, not the highlighter yellow |
| `--err` | `#ff6367` | `#c81232` | failed, destructive |
| `--on-err` | `#0a1317` | `#ffffff` | text on the critical fill |
| `--info` | = `--ink-3` | = `--ink-3` | neutral notice |
| `--live` | `#cf7ef0` | `#a121ce` | an agent is working *right now* |
| `--scrim` | `rgba(10,19,23,.66)` | `rgba(10,19,23,.55)` | overlay scrim (one layer) |

### The surface ladder runs both ways

In **dark** the ladder is elevation: 0 < 1 < 3 in perceived lift, with 2 as
the fill tier between card and drawer. **Light cannot reproduce that**,
because white is a ceiling you cannot build above — so 0..3 there is a ladder
of *distinctness*: cloud canvas `#eef1f5` → near-white cards `#fbfcfd`
(raised) → drawers/modals `#ffffff` (top plane), with `--surface-2`
deliberately **recessed** below the canvas.

The **zone** surfaces run the other way from dark. Dark builds the shell up
from the canvas (lift means lighter there); light cannot copy that, because a
near-white rail beside a cloud canvas makes the app's *chrome* the brightest
thing on screen and leaves the content sheet reading as the recessed part. So
in light the shell recedes — `--surface-rail` `#e2e7ed` < `--surface-list`
`#e8ecf2` < canvas — and lightness order becomes rail < list < canvas < card <
drawer, the same order the eye should travel. A search field or hover well
recedes from white and emerges from black; that inversion is correct, and only
`--surface-2` does it.

The source system paints its marketing canvas pure white and its wells in
`surface-soft` `#f1f4f7`. Relay is a three-pane application rather than a
scrolling page, so the two trade places: the cloud grey carries the page and
stark white carries the cards and floating chrome that sit on it. Both values
stay inside the published cloud/white pair — do not substitute a grey from
outside it, and do not paint shaded section bands over the canvas.

### Contrast floors

Every tier that can carry text clears WCAG 1.4.3 against **the worst plane it
can land on**, not against the canvas. Ratios against that plane:

| | ink-1 | ink-2 | ink-3 | ink-4 | ok | warn | err |
|---|---|---|---|---|---|---|---|
| dark (vs `--surface-3`) | 13.53 | 10.50 | 7.20 | 5.95 | 5.88 | 6.53 | 4.66 |
| light (vs `--surface-2`) | 14.94 | 13.29 | 7.22 | 5.02 | 4.63 | 4.77 | 4.66 |

`paletteTokens.test.ts` computes these from the declared hexes rather than
pinning the hexes themselves, so a future palette move is checked for
*legibility* rather than for matching a list. The same test asserts each
status tone still reads as **its hue** (green leads in `--ok`, red in `--err`,
amber's channels descend r > g > b) — the deepening AA forced on the light
register must not turn a green into a grey.

`--action-soft` is not a hex: it is a `color-mix` of the cobalt into
transparency, so the selection wash always tracks the action colour.

A **pinned group** (`--dark-canvas`, `--dark-surface`, `--dark-elevated`,
`--dark-ink`, `--dark-ink-soft`, `--dark-line`,
`--dark-line-soft`, plus `--light-canvas`)
mirrors the registers for chrome that must *not* follow the active theme: the
pre-auth login ramp, the theme-picker swatches that show both registers at
once, the diff viewer, ink-fill buttons. A test asserts each pinned token
equals its live counterpart — the pins silently drifted once already, which
is the failure they exist to prevent.

Artifact chips are **monochrome** — kind is carried by the icon and the mono
kind label, not by hue.

### The accent scope rule

Two accents, two jobs, and they never trade places:

| cobalt (`--action`) | Oculus purple (`--live`) |
|---|---|
| primary CTA, subscribe, save | composer running indicator |
| selection wash, active nav | task + backlog running rows |
| brand mark accent in app icons | agent stream activity, busy header |
| the selected-row accent bar | thread pulse, streaming rail node |
| | status pill on a running agent/node (TonePill `live`) |

**`--live` is legal exactly where `--t-pulse` is used, and nowhere
`--t-pulse-calm` is used.** Passive presence (online dot, idle node, login
readiness) stays neutral. A static purple surface never means "running", and a
pulsing neutral surface never exists.

"Two accents" is a claim about **meaning**, not pigment. The carve-outs, all
deliberate — a reader who takes the rule literally will file them as bugs:

- **Link blue is wayfinding, not decoration**: anchors in prose (`--link`)
  and the focus ring (`--focus-outline`). It is never a fill, a status, or an
  action.
- **App icons carry the cobalt.** `favicon.svg` and `relay-mark.svg` use
  `#0064e0` on their lead chevron. A tab-strip icon is not reporting a run,
  but at 16px a neutral chevron on a neutral square is invisible. The bare
  wordmark stays ink.
- **Identity marks are neutral.** Agents and teams render as neutral class
  glyphs (`IdentityMark.tsx`) — no procedural per-name hues. Identity is
  carried by glyph shape, never *what is happening*.
- **Syntax highlighting is a reading aid.** The five `--code-*` roles are the
  one place hue carries structure rather than meaning; they never appear
  outside a `code.hljs` block.
- **Login is a marketing surface.** Pre-auth runs on the pinned dark ramp
  because no theme has loaded; its primary CTA takes the register-invariant
  cobalt like every other primary action. The cover sets its field labels,
  footer meta, and status line in the mono face — a deliberate skin;
  everywhere else mono is technical text only.
- **Empty states remain still.** They share type, spacing, and an optional
  identity mark. There is no decorative ambient animation token.

Any **further** source of colour is a bug.

Because every `--live` surface also pulses and is accompanied by an elapsed
timer and status copy, colour is never the sole channel (WCAG 1.4.1). Motion
is part of that encoding, so `prefers-reduced-motion` needs checking whenever a
liveness surface changes.

## Typography

**One sans** carries every role — `--font-sans` and `--font-display` are the
same family, and the display tier is a size and weight decision, not a face
decision. **JetBrains Mono** (`--font-mono`) carries technical text only.

The display face is chosen by **content origin, not by size**: a fixed UI noun
(Threads, Backlog, the wordmark, a drawer title) takes the display tier, while
a string written by a person or an agent takes its calmer content sibling —
the source system's editorial-subhead move, where a lighter weight at a display size
introduces visual rest.

| Role | Spec | Paired track | Use |
|---|---|---|---|
| `--type-display` | 500 32/1.17 | `--track-display` (0) | hero headline, admin metric values |
| `--type-title` | 500 20/1.25 | `--track-display` (0) | page titles and other fixed UI nouns |
| `--type-heading` | 700 18/1.44 | `--track-0` | section heads, list labels, in-message h1 |
| `--type-title-content` | 400 20/1.25 | `--track-display` (0) | titles whose text comes from a user or agent |
| `--type-body` | 400 16/1.5 | `--track-body` | prose, message bodies, inputs |
| `--type-name` | 700 16/1.5 | `--track-body` | the identity of the thing a row or card is about |
| `--type-body-sm` | 400 13/1.43 | `--track-body-sm` | dense prose, captions |
| `--type-label` | 500 13/1.43 | `--track-body-sm` | chrome labels, nav, metadata |
| `--type-label-strong` | 700 13/1.43 | `--track-body-sm` | bold chrome, button and pill-tab labels |
| `--type-micro` | 700 12/1.33 | `--track-caps` (0) | structural group labels (+ uppercase), badges |
| `--type-number` | 500 24/1.28 | `--track-display` (0) | metrics |
| `--type-code` | 400 14/1.43 | `--track-0` | commands, logs, IDs |

**Every role ships a paired `--type-<role>-track`.** The `font:` shorthand
cannot carry `letter-spacing`, so a role applied as `font: var(--type-title)`
silently loses its tracking unless the call site remembers a second
declaration — pairing the tokens by name makes the omission greppable, and
`typographyTokens.test.ts` sweeps every stylesheet for it.

**The tracking runs the other way round here.** The source system tightens its
*reading* roles fractionally (−0.16px at 16px, −0.14px at 14px ≈ −0.01em) —
the snug-but-not-condensed setting Optimistic VF was drawn for — and sets the
display tier and the uppercase captions **solid**. Several paired tracks
therefore resolve to 0 by design; the tokens stay explicit so a role's
tracking is decided in `roles.css`, once.

**`ss01` and `ss02` ship together.** The source system treats them as a paired
alternates package for every heading role, never one without the other.
`base.css` declares the pair (`--font-features`) at the root: faces without
the sets ignore it, so fencing it to headings would buy nothing but a second
place to forget one of them.

**There is no 800.** IBM Plex Sans Variable tops out at 700 and `base.css`
disables font synthesis, so an 800 declaration would silently render as 700.
Nothing in the roles asks for it — in this system the heaviest weight (700)
already belongs to the small emphasis tiers, and the display tiers sit at 500.

The size ladder is **12 / 13 / 14 / 15 / 17 / 19 / 22 / 28px** at the
browser's default font size (`--fs-1/2/3/4/heading/title/5/6`). All sizes use
rem; the root is 87.5% (14px by default), so user font preferences scale type.
The hero size clamps between 22 and 36px. Dense prose (`--fs-3`, 14px) and
body copy (`--fs-4`, 15px) are distinct roles. Code uses 14px monospace.

**`--track-display` must be applied to every display-tier rule** — via the
role's paired track token or directly. Display-tier means *two* shapes, and
both are swept by the test:

1. rules using a `--type-display` / `title` / `heading` / `number` role, and
2. rules that opt into `font-family: var(--font-display)` by hand.

A second `letter-spacing` in the same rule silently overrides the first, so
the sweep requires exactly one correct declaration per display-tier rule.
The one deliberate exclusion is `.relay-bleed-mark`, a single decorative
glyph with no inter-character spacing to track.

**CJK:** `html:lang(zh-CN)` / `html:lang(zh-TW)` put a system CJK family first
for both Latin and Han glyphs, keeping mixed-script labels internally
coherent. Neither Optimistic VF nor IBM Plex Sans has Han coverage, so every
role joins that same sans stack — and **every** track is pinned to 0 there,
because Han glyphs are square and must never be tightened. Reading leading
loosens (1.7/1.8/1.9).

The vendored WOFF2 files are fontsource's **latin** subsets
(`@fontsource-variable/ibm-plex-sans` 5.3.0, OFL-1.1, wght 100–700;
`@fontsource-variable/jetbrains-mono` 5.3.0, OFL-1.1, wght 100–800). Latin
covers U+00C0–00FF, so accented names render in-face; latin-ext glyphs fall
through to the system sans by design rather than shipping a second file.

## Geometry, elevation, motion

- **Radii:** `--r-1` 4px for micro details; `--r-2` 6px for controls,
  tabs, and badges; `--r-3` 8px for cards, drawers, dialogs, and panels.
  `--r-full` is 9999px for actual circles/capsules. Tailwind's larger radius
  names clamp to `--r-3`; they do not introduce additional geometry.
- **Spacing:** 4px base — `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4`
  16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-7` 32 · `--sp-8` 48. The scale stops
  there: the source system's 64/80px section rungs shipped with no call site
  and were removed. Below
  the base sit exactly two micro steps, `--sp-0-5` 2 and `--sp-1-5` 6, for
  glyph-tight pairs (dot ↔ label, icon ↔ text, stacked meta lines). They are
  the only sanctioned sub-4px gaps. `--sp-row` (12px, compact 8px via
  `[data-density="compact"]`) sets row rhythm; `--control-h` is **44px** —
  the source system renders inputs and primary pills at the same height so they share
  a silhouette and clear the WCAG AAA touch floor.
- **Density:** `[data-density="compact"]` drops the reading tier one rung
  (`--fs-4` 15 → 14px; body-sm 13 → 12px) for genuinely dense surfaces (tables and list
  layouts). Put the attribute on the dense container, not the page. It
  overrides `--fs-4` **and restates every role built on it** (`--type-body`,
  `--type-name`, `--type-body-sm`), because a custom property resolves
  `var()` where it is *declared*, not where it inherits. Add a restatement
  whenever a new role uses `--fs-4`.
- **Elevation:** flat. `--shadow-1` is `none`; `--shadow-2` is a 0.5px
  `--line-1` ring without blur. Cards separate by surface and border;
  floating dialogs, drawers, menus, tooltips, and toasts share the ring.
- **Focus:** `--focus-outline` — a 2px solid **link-blue** ring at a 2px
  offset (WCAG 1.4.11), drawn with `outline`, **not** `box-shadow`, so no
  ancestor's `overflow: hidden` can clip it and forced-colors mode preserves
  it. The ring is not the cobalt action, so a focused primary button never
  rings in more of its own fill. Destructive controls take
  `--focus-outline-danger`, which differs by **both** colour (`--err`) and
  shape (dashed) — the stroke style is the half that survives forced-colors
  mode, where the hue is dropped.
- **Measure:** the reading-column cap, in `ch` — `--measure-tight` 34
  (captions, empty-state lines), `--measure` 48 (the default),
  `--measure-wide` 72 (long-form agent prose). Anything narrower is a layout
  width, not a measure: give it px and a reason.
- **Z layers:** three tiers, all with consumers — `--z-drawer` 30 ·
  `--z-float` 120 · `--z-dialog` 300. There is deliberately no `popover` tier
  below `drawer`. Bare `z-index: 1/2/3` in component CSS orders siblings
  inside an already-positioned component and must not be promoted to tokens.
- **Motion:** `--ease` `cubic-bezier(0, 0, 0.2, 1)` (ease-out); `--t-fast`
  150ms, `--t-slow` 250ms — the source system publishes no timings and
  recommends 150–250ms for surface transitions. No spring, no overshoot.
- **Ambient loops:** `--t-pulse` 1.6s for active work (streaming agent,
  running task, busy header) and `--t-pulse-calm` 2.6s for passive presence
  (online dot, idle node) — the same liveness reads at the same tempo
  everywhere. `--t-tick` 1s is the mechanical cadence: a spinner rotating, a
  caret blinking. Never hand-pick a loop duration.
- **Other durations:** `--t-draw` 1.1s for content that renders itself over
  real time; `--t-stagger` 40ms as the base step for reveal ladders,
  multiplied at the call site. Delays are expressed against `--t-stagger`,
  never as literals — `designGrid.test.ts` enforces it.
- **Entrances:** one shared `rise` keyframe (`tokens/base.css`) — fade plus
  a translateY read from `--rise-from`. Two travel tiers: `--rise-sm` 4px
  for rows inside a scroller, `--rise` 8px (the default) for panes and
  views.

## Marginalia

Relay keeps one small decorative gesture: the **double-chevron mark** bled off
the lower-left corner of the pinned-dark login cover — hairline-weight ink
linework at 5% ink, fixed position — shipped as the inline `Chevrons` SVG in
`web/src/components/LoginScreen.tsx` with the `.login-bleed` rule in
`login.css`. The rules:

- **Ink only.** The mark never takes an accent (action or live), never takes
  a status tone, never fills — strokes alone.
- **Never animate it.** It is set dressing in an operator tool;
  `prefers-reduced-motion` is trivially satisfied because there is no motion.
- **Absolutely positioned**, so it never perturbs the layout it decorates.
- One mark per surface. A second one on the same screen is clutter, not
  charm.

Empty states carry no decorative layer — no dashed construction plate, no crop
ticks, no corner doodles, no bled watermark glyph, no orbit ring. A zero-data
surface is a moment where the product has nothing to show; dressing it up
reads as apology. They are composed from type, spacing, and one optional mark
tile (`.relay-empty-avatar` in `empty-state.css`), shared by the centered
`RelayEmptyState` and the board and transcript variants.

## Do's and Don'ts

### Do
- Use `--action` for actions, and use it scarcely: primary CTA, selection,
  the brand mark. One cobalt pill per fold is plenty — the source system's own
  note is that the colour's weight is meaningful precisely because it is rare.
- Pair the action fill with `--on-action` — white on the cobalt, in both
  registers.
- Use `--action-soft` for selected rows and active navigation.
- Give buttons, tab chips, and badges `--r-2`; reserve `--r-full` for
  actual circles and capsules.
- Carry status as dots/borders/text on the semantic tones; use `--info` for
  status without alarm.
- Use `--live` only for work happening right now, and only where `--t-pulse`
  is used — see the scope rule under Colors.
- Pair `--live` with motion and text, never colour alone.
- Use `--link` for anchors and the focus ring; `--measure*` for reading
  columns.
- Apply the paired `--type-*-track` at every display-role site, even where
  the paired track is 0 — the declaration is the contract.
- Disable with opacity, not a dedicated hex.
- Separate surfaces with fills and hairlines; floating chrome adds a ring, not blur.
- Add new raw values to `palette.css` and new roles to `roles.css` — never
  inline a colour in a component file (`npm run lint:css -w web` enforces).

### Don't
- Don't use a status colour as an action, or the action colour as a status.
- Don't introduce a third accent. Cobalt is the action, purple is liveness,
  blue is wayfinding; everywhere else the ink ramp is the only signal.
- Don't give controls pill corners or introduce radii beyond the 4/6/8px ladder.
- Don't set text or dots in a status tone taken straight from the source
  system's badge palette — those are *fill* values (success `#31a24c` measures 3.1:1
  on white, warning `#f7b928` 1.8:1). The tokens here are already the
  text-safe tuning; use them.
- Don't paint shaded section bands over the canvas — the page is one sheet.
- Don't fill backgrounds with status colours.
- Don't tint agent avatars with vendor brand colours — glyph shape carries
  identity.
- Don't add overshoot or extra easing curves — there is exactly one ease.
- Don't colour artifact chips by kind — icon + label only.
- Don't paint a focus ring as a `box-shadow` — it is an `outline`, so it
  survives clipping ancestors and forced-colors mode.
- Don't hand-write a `ch` width for prose; reach for the `--measure*` tier.
- Don't add a size step off the source system's ladder — separate by weight
  instead.
- Don't declare `font-weight: 800` — Plex tops out at 700 and synthesis is
  disabled; the declaration would be a lie.

## Shell dimensions

| Token | Value | Use |
|---|---|---|
| `--sidenav-w` | 72px | Collapsed left rail |
| `--sidenav-w-open` | 228px | Expanded left rail |
| `--thread-w` | 318px | Conversation list pane |
| `--header-h` | 64px | Chat panel top bar (the source system's nav height) |

## Responsive behaviour

Relay's breakpoint registry lives in a comment at the top of `palette.css` —
custom properties cannot drive `@media`, so that list is the only registry
there is, and it must be updated when a query is added. The app-wide tiers are
**820px** (mobile) and **1040px** (tablet); everything else is a component tier
(480 narrow phone · 640 compact panes · 768 container queries · 900 dashboard
medium · 1100 multi-pane → single pane · 1200 dashboard widest). Two rules of thumb: a
new query reuses a tier above rather than inventing a neighbour, and one
component gets one breakpoint.

The source system's own tiers are marketing-page tiers (< 480 · 480–767 ·
768–1023 · 1024–1359 · ≥ 1360) and its collapsing rules are about heroes,
feature grids, and a PDP purchase rail Relay does not have. What carries over
is the *behaviour*: multi-column layouts collapse toward one column, side rails
become sticky bottom chrome, and display type steps down the ladder rather than
scaling continuously.

**Touch targets.** The source system renders pill buttons at 40–44px, circular
icon buttons at 40px (bumped to 44 on mobile), and form inputs at 44px. Relay
pins `--control-h` to 44px so buttons and inputs share that silhouette
outright, and `a11y.css` raises the *dense* tiers — in-row chips, toggles,
icon buttons, the `sm`/`xs` button sizes — to `--touch-target` under
`@media (pointer: coarse)`, leaving desktop mouse density alone.


## Data visualization

Charts run on the ink ramp — a brightness ramp, not a hue ramp. The admin
token-usage chart stacks a three-step ink ramp, dimmest at the base: output =
`--ink-2` (brightest — it is the product of the work), input = `--ink-3`,
cache = `--ink-4` (the bulk, but the least interesting). **No series may take
`--action`**: a cobalt chart fill reads as "click me". Because the ramp
deliberately uses neighbouring ink steps, each segment carries a
`--surface-1` hairline stroke — adjacent steps of a monochrome ramp merge
into one flat band without it.

Fleet-health bars double-encode: the ink ramp alone cannot separate five
values in an 8px bar, so stale takes a `--warn` hatch. `--live` marks the
running node count and its bar segment — the card's accent density is a
utilisation readout: live-carrying elements when work is in flight, none when
idle.

---

## Shared component contracts

- Slotted primitives own their border, fill, disabled, focus, and invalid
  states. Native element resets must exclude all `data-slot` controls; the
  `relay` layer follows Tailwind utilities and otherwise overrides them.
- Overlay inputs keep the shared control boundary (`--control-border`). Only
  their fill changes to `--field-on-overlay`; structural hairlines are not
  field boundaries. Error borders remain `--err`.
- `--tone-line` resolves on each element and pseudo-element from its local
  `--tone`. Defining this composite only on the root would freeze the neutral
  fallback before a badge or alert supplies its tone.
- Ordinary disabled controls use `--opacity-disabled` (0.6). Filled primary
  and destructive buttons retain their explicit full-opacity disabled fills.
- Switches retain a 36×20px track on both pointer types, with a pseudo-element
  providing a 44px target. Touch sizing must not enlarge the visible track.
- Toast stack geometry belongs to Toast; its appearance uses `--shadow-2`,
  `--ease`, `--t-slow` for movement/opacity and `--t-fast` for height.

| Control size | Height | Button | SelectTrigger |
| --- | --- | --- | --- |
| Inline | 24px | `xs`, `icon-xs` | — |
| Dense row | 32px | `dense`, `icon-dense` | — |
| Small standalone | 40px | `sm`, `icon-sm` | `sm` |
| Default | 44px | `default`, `icon`, `cta` | `default` |
| Large | 48px | `lg`, `icon-lg` | — |

Existing 32px button consumers use `dense` explicitly. Touch controls may
increase to the shared target floor; compact visual controls use separate hit
areas. Do not change row density as a side effect of aligning API names.

## Reviewing changes

Run `npm run dev -w web` and open `/dev/design-system` for a specimen composed
from the actual primitives. It uses no API records and returns not-found in
production. Use the light/dark controls, drawer, and toast actions to inspect
states. It is a focused control specimen, not a substitute for real-route review.

Run `npx playwright install chromium` once, then `npm run test:design -w web`
for computed-style checks in desktop and touch Chromium, in both themes.
The suite covers chrome, tone scope, invalid overlay fields, disabled opacity,
size parity, switch geometry, toast elevation/motion, and reduced motion.
Keep source-level token tests too: they check vocabulary and ownership, while
browser checks prove the styles that actually win the cascade.

# Appendix — the source system

Everything below is the extracted Meta commerce design system that Relay's
identity is adapted from. It was captured from four surfaces — meta.com
(homepage), the Ray-Ban Meta Skyler Gen 2 product page, the Quest 3S buy-now
configurator, and the AI-glasses prescription page — and token coverage was
identical across all four, so the system is genuinely unified rather than
per-page. It is reproduced here so this document stands alone; the sections
above are the authority on what Relay ships, and this appendix is the
authority on where those decisions came from.

Note the register difference throughout: the source is a **marketing and
commerce site** with full-bleed product photography, and Relay is a dense
multi-pane operator tool. Where the two disagree, the sections above record
which way Relay went and why.

## Source voice

Meta's commerce surfaces read as a confident hardware merchandiser. The voice
is photography-first: large, full-bleed product imagery dominates above-the-fold
real estate, with white space and a tight typographic hierarchy carrying the
rest. The signature is a dual-CTA pattern — a black pill primary on marketing
surfaces shifting to saturated cobalt inside buy-now flows, paired with an
outlined ghost button for the secondary action.

Key characteristics:

- Stark white canvas carrying full-bleed product photography, with 32px corner
  softening on showcase tiles.
- A two-tier primary button system: black pills on marketing, cobalt pills
  inside buy-now panels.
- Optimistic VF as the universal display *and* body face, with `ss01, ss02`
  switched on together.
- Pill buttons and 32/40px cards as the dominant geometric signature.
- Saturated promotional banners (yellow, or dark ink) used sparingly above the
  nav for time-bound offers.
- Photographic feature cards with no card chrome at all — the product imagery
  *is* the surface treatment.

## Source colors

| Source name | Value | Role in the source system |
|---|---|---|
| `primary` | `#0064e0` | Cobalt buy-now CTA — "Add to cart", "Configure", "Pre-order" |
| `primary-deep` | `#0457cb` | Pressed state; also the active link colour |
| `primary-soft` | `#0091ff` | Translucent informational callout tint (at 15% alpha) |
| `on-primary` | `#ffffff` | Text on the cobalt fill |
| `ink-button` | `#000000` | Marketing-surface primary pill |
| `on-ink-button` | `#ffffff` | Text on the black pill |
| `fb-blue` | `#1876f2` | Selected radio/checkbox, inline form-control activation |
| `meta-link` | `#385898` | Legacy navigation and footer link affordances |
| `oculus-purple` | `#a121ce` | VR product accent, category emphasis on Quest surfaces |
| `success` | `#31a24c` | "In stock", "Free returns" |
| `success-bg` | `#24e400` | Saturated success fill |
| `attention` | `#f2a918` | Mid-priority alerts, timed callouts |
| `warning` | `#f7b928` | Promo banners, limited-time tags |
| `warning-bg` | `#ffe200` | Saturated promo fill |
| `critical` | `#e41e3f` | Validation errors, destructive feedback |
| `critical-strong` | `#f0284a` | Form-input error border, inline error labels |
| `canvas` | `#ffffff` | Page background and primary card surface |
| `surface-soft` | `#f1f4f7` | Product thumbnails, warranty cards, search-pill rest |
| `ink-deep` | `#0a1317` | Primary headline and body text on light surfaces |
| `ink` | `#1c1e21` | Standard body and secondary headline text |
| `charcoal` | `#444950` | Tertiary body text, form-button labels |
| `slate` | `#4b4c4f` | Section-header copy, supporting microcopy |
| `steel` | `#5d6c7b` | Quieter caption text, footer link hierarchy |
| `stone` | `#8595a4` | Disabled or de-emphasised labels |
| `hairline` | `#ced0d4` | 1px input border, form-control divider |
| `hairline-soft` | `#dee3e9` | Quieter divider on cards, footers, section breaks |
| `disabled-text` | `#bcc0c4` | Disabled button fill |

### How Relay maps them

| Source token | Relay token | What changed and why |
|---|---|---|
| `primary` / `primary-deep` / `on-primary` | `--action` / `--action-hover` / `--on-action` | Unchanged values. Relay is entirely in-product, so cobalt is *the* action rather than a commerce-only variant. |
| `ink-button` / `on-ink-button` | — | Not adopted. Relay is entirely in-product, so cobalt is the primary on every surface; a black marketing pill has no caller here. |
| `primary-soft` | `--action-soft` | Carried as a `color-mix` wash rather than a flat hex, so the selection tint tracks the action colour. |
| `meta-link` | `--link-blue` (light) | Verbatim. Dark lifts it to `#8ab4f8` for AA on the ink-deep canvas. |
| `oculus-purple` | `--live` | Verbatim in light, lifted in dark. Relay spends the second sanctioned accent on liveness because cobalt is already the action. |
| `success` / `warning` / `critical` | `--ok` / `--warn` / `--err` | Hue family kept; lightness retuned per register so each clears 4.5:1 as *small text* — the published values are badge-fill colours. The warning additionally walks from the published golden yellow (hue 82) to an amber at hue 65, so a caution stops out-shouting the critical red beside it and keeps 43° of clearance from it. |
| `canvas` / `surface-soft` | `--surface-3` / `--surface-2`, `--surface-0` | Traded places: in a three-pane app the cloud grey carries the page and white carries cards and floating chrome. |
| `ink-deep` / `ink` / `charcoal` | `--ink-1` / `--ink-2` / `--ink-3` | Verbatim. |
| `steel` | `--ink-4` | Deepened to `#556170`; the published value measures 4.34:1 against the recessed fill. |
| `stone` / `disabled-text` | — | Not adopted. Disabled is opacity in Relay, so a dedicated disabled ink has no consumer. |
| `hairline` / `hairline-soft` | `--line-1` / `--line-2` | Verbatim. |
| `fb-blue` | — | Not adopted; the focus ring and form activation both run on `--link`, which clears AA as text as well as being an indicator. |
| `success-bg` / `warning-bg` / `attention` / `critical-strong` | — | Not adopted. Relay renders status as ink, not as saturated fills, so the fill-only tiers have no job. |

## Source typography

**Optimistic VF** is Meta's proprietary variable display face; the published
fallback chain is Montserrat, Helvetica, Arial, Noto Sans. Its axes run from
300 (editorial subheads) through 500 (hero, display, heading-sm) to 700
(subtitles, body emphasis, button labels). `ss01` and `ss02` are switched on
across every heading role and are treated as a paired package — never one
without the other. A secondary Helvetica chain carries 12px technical microcopy
in spec sheets and footer fine print.

| Source role | Size | Weight | Line height | Tracking | OpenType | Use |
|---|---|---|---|---|---|---|
| `hero-display` | 64px | 500 | 1.16 | 0 | ss01, ss02 | Homepage hero, category opener |
| `display-lg` | 48px | 500 | 1.17 | 0 | ss01, ss02 | Section-opener display |
| `heading-lg` | 36px | 500 | 1.28 | 0 | ss01, ss02 | Subsection headlines |
| `heading-md` | 28px | 300 | 1.21 | 0 | ss01, ss02 | Editorial subheads in the light weight |
| `heading-sm` | 24px | 500 | 1.25 | 0 | ss01, ss02 | Card titles, feature-tile headers |
| `subtitle-lg` | 18px | 700 | 1.44 | 0 | — | Bold callouts, FAQ question titles |
| `subtitle-md` | 18px | 400 | 1.44 | 0 | — | Body lead, longer-line subtitles |
| `body-md` | 16px | 400 | 1.50 | −0.16px | — | Primary body text |
| `body-md-bold` | 16px | 700 | 1.50 | −0.16px | — | Body emphasis; also `link-md` |
| `body-sm` | 14px | 400 | 1.43 | −0.14px | — | Secondary body, helper text |
| `body-sm-bold` | 14px | 700 | 1.43 | −0.14px | — | Pill-tab labels, footer headings |
| `caption-bold` | 12px | 700 | 1.33 | 0 | — | Badge labels, timestamps |
| `caption` | 12px | 400 | 1.33 | 0 | — | Footer fine print, legal microcopy |
| `button-md` | 14px | 700 | 1.43 | −0.14px | — | Pill button labels |
| `link-md` | 16px | 700 | 1.50 | −0.16px | — | Inline navigation links |

Source principles:

- Negative letter-spacing on the *reading* roles (−0.14 to −0.16px) tightens
  the type fractionally; the face was drawn for that snug-but-not-condensed
  setting.
- Editorial subheads use the 300 weight to introduce visual rest between the
  500-weight displays and the 400-weight body — a three-tier rhythm.
- All headings carry `ss01, ss02` together.
- Buttons, pill tabs, and footer headings share `body-sm-bold`, which is what
  visually relates the interactive elements to each other.

**What Relay does with it:** the ladder above collapses to 12 / 14 / 16 / 18 /
24 / 36 / 48 plus a hero clamp. The 28px/300 editorial tier is not adopted as a
size — Relay expresses the same "visual rest" idea as `--type-title-content`
(24px/400), because a dense operator tool has no editorial intro headlines. The
proprietary face is not redistributable, so `--font-sans` names it first and
ships vendored IBM Plex Sans behind it; Plex tops out at 700, which is why no
role declares 800 and why the 300 weight is unused.

## Source layout scales

**Spacing** — 4px base with 8px as the dominant step: 4 · 8 · 10 · 12 · 16 ·
20 · 24 · 32 · 40 · 48 · 64 · 80 · 120. Marketing sections separate at 80px,
product-detail sections at 64px, FAQ stacks at 32px. Card padding is 32px
standard, 24px for icon-feature tiles, 64px for promo strips. Relay adopts the
whole scale except the 10px and 120px rungs (10 is off the 4px grid; 120 is a
marketing hero gutter with no in-app consumer) and adds nothing below 4px
except its two documented micro steps.

**Grid** — marketing pages cap near 1280px with 32–48px gutters; the PDP is a
58/42 split with a `max-width: 380px` sticky purchase rail; three-up feature
grids use a 24px column gap and six-up thumbnail rows a 12px gap. Relay's
equivalent caps are `--thread-measure` (1200px) and the `--measure*` reading
tiers.

**Radii** — 2 · 4 · 6 · 8 · 16 · 24 · 32 · 40 · 100 (pill) · 50% (circle).
Product hero photography sits in 32px frames; square thumbnails take 16px;
selection-grid tiles take 8px, deliberately tighter than showcase frames;
swatches are 32px circles with a 2px white ring when selected. Relay keeps
4 / 8 / 16 / 24 / 32 / pill and drops the 2px, 6px, and 40px rungs — 2 and 6
are finer than anything in the app's chrome, and 40 belongs to accessory hero
panels.

**Elevation** — three levels, only two of which are shadows:

| Level | Treatment | Use |
|---|---|---|
| 0 (flat) | No shadow; 32px rounding + hairline-soft border | Product cards, why-buy tiles |
| 1 (subtle) | `rgba(0,0,0,0.2) 1px 1px 0 0` | Pill-tab activation indicator |
| 2 (sticky panel) | `rgba(20,22,26,0.3) 0 1px 4px 0` | PDP purchase summary, sticky mobile checkout bar |

Relay wires level 0 to `--shadow-1` (`none`) and level 2 to `--shadow-2` (the
published blur plus a hairline ring). Level 1 has no Relay consumer — its job
is a pill-tab active state, which Relay signals with the dark fill instead.

Decorative depth in the source is photographic: full-bleed imagery on rounded
cards creates atmosphere without shadows, and translucent overlays
(`rgba(255,255,255,0.1)` to `rgba(10,19,23,0.12)`) lift text off dark hero
photography. Pastel tints behind accessory cutouts are photographic content,
not system tokens.

## Source components

Hover states are deliberately undocumented in the source — default and
pressed/active only.

### Buttons

- **`button-primary`** — black pill, white label, `button-md` type, `14px 30px`
  padding, full radius. Pressed flips the fill to `charcoal`; disabled uses
  `disabled-text`.
- **`button-buy-cta`** — cobalt pill, white label, same type and metrics.
  Pressed deepens to `primary-deep`. Appears *only* inside the buy-now
  configurator and PDP purchase rail.
- **`button-secondary`** — transparent, ink-deep label, `2px solid ink-deep`
  border, `12px 28px`, full radius. The usual partner in a dual-CTA hero.
- **`button-ghost`** — transparent with a `2px solid rgba(10,19,23,0.12)`
  border, `10px 22px`, full radius. Tertiary actions.
- **`button-pill-tab`** / **`-active`** — white with a hairline border and
  `8px 16px` padding; active swaps to an ink-deep fill with white text and no
  border.
- **`button-icon-circular`** — 40×40px, white, ink icon, circular.

### Cards and containers

- **`card-product-feature`** — white, 32px radius, 32px padding, hairline-soft
  border.
- **`card-feature-photo`** — 32px radius, no padding, no border; the image
  fills the card and copy overlays bottom-left in white.
- **`card-promo-strip`** — ink-deep fill, white text, 32px radius, 64px
  padding.
- **`card-icon-feature`** — white, 16px radius, 24px padding.
- **`card-checkout-summary`** — white, 16px radius, 24px padding, hairline-soft
  border, level-2 shadow.
- **`product-thumbnail`** — surface-soft, 16px radius, 16px padding, 1:1.
- **`warranty-card`** — surface-soft, 24px radius, 32px padding.
- **`why-buy-tile`** — white, 16px radius, `32px 24px` padding, hairline-soft
  border; heading `subtitle-lg`, body `body-sm`.

### Inputs and forms

- **`text-input`** — white, ink text, 1px hairline border, 8px radius, 12px
  padding, 44px tall. Focused swaps to a `2px solid fb-blue` border; error to a
  `1px solid critical-strong` border with the error label below in the same
  colour at `body-sm`.
- **`search-pill`** — surface-soft fill, steel text, `body-sm`, full radius,
  40px tall.
- **`radio-option`** / **`-selected`** — white, 8px radius, 20px padding, 1px
  `rgba(10,19,23,0.12)` border; selected swaps to `2px solid #0143b5`.
- **`color-swatch-circle`** — 32px circle with a 2px white ring on selection.

### Badges and banners

All four badges share the same chrome — `caption-bold` type, full radius,
`4px 10px` padding — and differ only by fill: promo yellow (`warning`, ink-deep
text), attention (`attention`, white text), success (`success`, white text),
critical (`critical`, white text). **`promo-banner`** is a full-width strip
*above* the nav in ink-deep or yellow, `body-sm-bold`, `12px 24px` padding,
carrying one line of offer copy and an inline link.

### Navigation

Desktop: a sticky white bar ~64px tall with a bottom hairline-soft border —
wordmark left, pill-tab category nav centre, search-pill plus circular icon
buttons right. Mobile: logo, hamburger, cart; the pill nav slides into a
full-screen drawer below 768px. Breadcrumbs on the PDP set `body-sm` with a
stone separator dot, an ink active leaf, and steel parent links.

### Signature compositions

- **`hero-band-marketing`** — full-bleed photography, `hero-display` copy in
  white, a `subtitle-md` line, then the `button-primary` + `button-secondary`
  pair.
- **`product-gallery-pdp`** — 80×80px thumbnail strip (8px radius,
  surface-soft, hairline-soft border; active border goes ink-deep), a
  ~720×720px main image at 32px radius, and the sticky
  `card-checkout-summary` rail.
- **`color-sku-picker-row`** — six-up 1:1 tiles, surface-soft, 8px radius,
  16px image padding; active tile takes a `2px solid ink-deep` border, with the
  variant name in `body-sm-bold` and price in `body-sm` below.
- **`feature-icon-row`** — four `card-icon-feature` cells, each a 32px line
  icon, a `subtitle-lg` headline, and `body-sm` copy.
- **`faq-accordion`** — 16px-radius items, question in `subtitle-lg`, a 20px
  steel chevron right, answer in `body-md` with 16px top padding.
- **`tech-specs-table`** — two columns: label `body-sm-bold` ink, value
  `body-sm` charcoal, rows separated by a hairline-soft rule, group headers in
  `heading-sm`.
- **`testimonial-customer-card`** — white, 16px radius, 32px padding,
  hairline-soft border, 40px avatar circle, `body-sm-bold` byline, `body-md`
  quote.
- **`footer-region`** — white with a hairline-soft top border and
  `64px 32px` padding; six column groups with `body-sm-bold` headings and
  `body-sm` steel links, and a bottom row of `caption` legal links in stone.

**What Relay implements:** the button, input, badge, and card chrome above map
directly onto the shadcn primitives (`ui/button.tsx`, `ui/input.tsx`,
`ui/badge.tsx`, `ui/card.tsx`) and the surface stylesheets. The commerce-only
compositions — PDP gallery, SKU picker, promo banner, FAQ accordion,
testimonial card, marketing footer — have no counterpart in an operator tool
and are recorded here for reference only. Their *chrome rules* still apply
whenever a similar object appears: a summary rail takes the checkout-summary
treatment, a spec table takes the tech-specs treatment.

## Source do's and don'ts

**Do**

- Reserve cobalt for buy-now CTAs; its weight is meaningful precisely because
  it does not appear on marketing pages. *(Relay reads this as: keep the action
  colour scarce — one cobalt pill per fold.)*
- Use the black pill for marketing-surface primaries, paired with the outlined
  secondary.
- Apply the full radius to every button, category pill, badge, and chip.
- Apply 32px to photographic product cards and 16px to icon-feature tiles, so
  the card hierarchy stays visible.
- Switch on `ss01, ss02` together for any heading — never one without the other.
- Use the 300-weight editorial tier for subheads; it creates the signature
  rhythm against the 500-weight displays.

**Don't**

- Don't use cobalt for marketing-surface primaries.
- Don't introduce accent colours beyond cobalt and Oculus purple — the hardware
  brand is deliberately monochromatic outside its product photography.
- Don't soften a pill below the full radius; the pill is a brand signature.
- Don't run feature cards without rounding — 32px is the floor for a
  photographic surface.
- Don't reduce `body-md` line-height below 1.50; the negative tracking already
  tightens the metric.
- Don't apply heavy shadows to marketing cards — elevation is a commerce-flow
  signal, not a marketing flourish.

## Known gaps, and what Relay did about them

The source analysis flagged four gaps. Each is closed here, and this is where
to look before "fixing" something that looks unspecified:

1. **Selected/checked states for non-button form controls** were not visible on
   the captured surfaces. Relay follows the `radio-option-selected` pattern —
   cobalt on white — for `Checkbox` and `Switch` (`data-checked` takes the
   `--action` fill).
2. **No animation or transition timings** were extracted; the analysis
   recommended 150–250ms ease-out for surface transitions and 300ms for
   accordion expand/collapse. Relay pins `--ease` to `cubic-bezier(0, 0, 0.2, 1)`
   with `--t-fast` 150ms and `--t-slow` 250ms, and adds its own liveness
   cadences (`--t-pulse`, `--t-pulse-calm`, `--t-tick`, `--t-draw`,
   `--t-stagger`) which the source has no equivalent for.
3. **No dark-mode tokens** are published. Relay's dark register is derived —
   `ink-deep` becomes the canvas, the cloud greys invert into an elevation
   ladder, and cobalt stays put because white clears AA on it either way. Every
   derived value is documented at its token in `palette.css`.
4. **Pastel decorative tints** behind accessory cutouts are photographic
   content, not system colours. Relay has no equivalent surface and does not
   introduce one.

One further gap is Relay's own: the source system has no vocabulary for *work
in progress* — no "an agent is running right now" state — because a commerce
page has nothing that runs. `--live`, the pulse cadences, and the `StateMark`
shape vocabulary are Relay additions built on the one accent the source leaves
unspent.

A second addition covers *status proportions*, which the source system's
data-viz vocabulary has no grammar for. Fleet utilisation bars
(`admin-v2-dashboard.css`) therefore paint their segments in solid status
tones — `--live`, `--err`, `--ok`, a `--warn` hatch — because a bar segment IS
the datum, not canvas chrome; the "status is text/dot only, never fills" rule
still holds everywhere else. The artifact diff viewer (`artifact.css`) makes
the same kind of content-display exception: add/del rows carry 16%
`--ok`/`--err` background washes, the universal diff grammar no token rule
needed to invent.
