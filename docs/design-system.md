# Relay Design System

<p align="center">
  <img src="../web/public/brand/relay-logo.svg" alt="Relay logo" width="360">
</p>

## Overview

The executable source of truth is `web/src/styles/tokens/`. This document
specifies Relay's current dense workspace UI. The [source-system appendix](#appendix--the-source-system)
is historical design reference, not a component specification: Relay adapts its
colors and typography but uses compact corners and flat elevation.

> **A neutral canvas carries the content; the ultramarine accent carries the
> one action to take and marks what is selected; purple means an agent is
> working.** The logo draws both as a handoff: an ultramarine lead chevron
> (what a person does) and a purple trailing one (an agent carrying it on).

**One brand blue.** `--action`, `--link`, the focus ring, and the app icons'
lead chevron all sit on one hue (oklch 268, ultramarine): 10° toward violet
from stock SaaS cobalt so the product owns its blue, and still 47° clear of
`--live` so "act" never reads as "working". `paletteTokens.test.ts` asserts
the shared hue and that every icon matches its register's tokens.

Near-black and near-white canvases (`#0a0a0a` / `#fafafa`), achromatic grey
elevation and hairlines, a neutral ink ramp, the source system's semantic
status hues, and blue held back for the primary action, selection, and
links. The surfaces follow Vercel Geist's neutrals (PR #324); the primary
action follows Linear's convention of a console that leads with its accent.
It supersedes the cloud-canvas commerce register, which superseded Fieldnotes
and Phosphor.

- **The primary action wears the accent — one per view.** shadcn's
  `--primary` points at `--action` (`shadcn-bridge.css`), so every default
  `Button` and the page's create action fill with ultramarine in both registers,
  the way Linear leads with its accent. It is a scarce mark: one filled
  primary per view, and anything beside it steps down to `outline` or
  `ghost` (the page-header "+" is neutral `--surface-2`). There is no
  disabled hex — disabled is opacity, or the Button's explicit disabled
  surface for filled variants. The neutral inverted `--cta-fill` survives
  only for the few fills that read it directly — the composer's circular
  send button, the landing page's primary plate, and the profile-image
  picker's hover disc; the login screen repaints its CTA (`.login-submit`)
  as the theme's neutral ink plate.
- **The accent also marks selection.** `--action` is **tuned per register** — light
  `#7194fe` with dark `--on-action` (6.95:1) on the dark canvas, deep `#2a44d3`
  with white (7.3:1) on the light one; `--action-hover` moves away from the
  canvas (`#90aefe` / `#2237af`). Beyond the primary fill it says *this one*:
  the selected-row accent bar, the active nav marker, checked checkboxes,
  radios and switches, the current pager page, `::selection`, and the skip
  link. Selection stays calm — a 10% wash plus the bar, never a solid fill —
  so a selected row never reads as a button. The token keeps its historical name.
  Links are **not** `--action`: they take `--link`, reserved for wayfinding —
  anchors in prose and the focus ring.
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
  ramp's calm end (`--ink-4` `#666666`) stops where it does: one step lighter
  and meta text on the recessed fill drops under AA. Disabled is opacity, so
  no lighter "disabled label" tier exists.
- **Dual-first registers.** Dark is the default register (`:root`);
  `html[data-theme="light"]` overrides it. Both are achromatic: the dark
  canvas `#0a0a0a` lifts through `#171717` cards to `#262626` drawers, and the
  light canvas `#fafafa` carries white cards and white floating chrome,
  separated by hairlines rather than a grey wash.
- **Two accents, two jobs.** Cobalt and Oculus purple, and nothing else.
  Cobalt is selection; the purple is `--live`, work an agent is doing *right
  now*. Splitting them across hues rather than across channels is deliberate:
  a pulsing blue dot beside a selected blue row would put "working" and
  "chosen" in the same colour.
- **One sans, every job.** Relay sets everything in the **platform UI face**
  (San Francisco, Segoe UI, Roboto, Noto Sans) — no sans web font is loaded,
  and English and Chinese share one stack.
  Hierarchy is built from **size and
  weight** (400/500/700), never from a second face. The weight ramp is
  inverted against the usual expectation: the display tiers are 500 and the
  heaviest weight belongs to the *small* emphasis roles (`--type-heading`,
  `--type-label-strong`); 700 stays scarce, so names, button and badge
  labels sit at 500. JetBrains Mono survives for technical text only — IDs, logs,
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
   the register-invariant scales (radii, opacity, spacing, control and card
   heights, icon / avatar / dot sizes, measure, type sizes, tracking,
   leading, z-index, motion, families, shell dimensions) and the breakpoint
   registry comment. This is the *only* file allowed to originate a color —
   enforced by `web/.stylelintrc.json`.
2. **`roles.css`** — the composites: the `--type-*` roles and their paired
   `--type-*-track` tokens, `--shadow-1` / `--shadow-2`, the focus contract
   (`--focus-outline` / `--focus-outline-danger` / `--focus-w` /
   `--focus-offset`), `--link` / `--link-hover`, the `--info` alias, and the
   interaction roles (`--row-hover`, `--line-strong` / `--line-drag`,
   `--accent-bar*`, `--control-fill*`, `--control-border*`,
   `--control-track`, `--field-on-overlay`, `--tone-line`).
3. **`shadcn-bridge.css`** — the `@theme inline` block and
   `--background` / `--primary` / etc. aliases that shadcn/ui and Tailwind
   utilities consume. Utility names (`text-ink`, `border-hairline`,
   `rounded-md`, `text-sm`) stay stable so component markup never tracks
   token renames. Note shadcn's own `--accent` / `--ring` names are its
   aliases (highlighted row / outline color), which is why the selection
   family is named `--action`, not `--accent`. `--accent` points at
   `--control-fill-hover`, a translucent ink wash, never a fixed surface: menus
   paint on `--popover` (`--surface-3`), and a fixed plane matched it in light
   (white on white) and sank below it in dark. `--ring` points at `--link`:
   a focused control must not ring in its own fill.

   The `text-*` utilities map one name per rung: `text-xs` → `--fs-1`
   (12px), `text-sm` → `--fs-2` (14px), `text-dense` → `--fs-3`,
   `text-base` → `--fs-4`, `text-lg` → `--fs-heading` (15px), `text-xl` →
   `--fs-title` (16px), `text-2xl` → `--fs-5` (22px), `text-3xl`/`4xl` →
   `--fs-6` (28px). `--fs-3` and `--fs-4` are both 14px today (the compact
   reading size), so `text-base` is 14px, not Tailwind's 16px. `text-dense`
   is the one Relay-only name, for the dense-prose rung Tailwind has no word
   for. Weight utilities clamp onto the three rungs (`font-semibold` → 700).

   The file has two halves with different rules. The **additive** colour
   aliases exist only if a component asks for them — Tailwind ships no default
   for `text-ink`, so an unused entry is dead and gets deleted. The **scale
   guards** (`--radius-*`, `--text-*`, `--spacing`) override stock Tailwind
   scales, so they are kept complete whether or not each step is used:
   deleting `--radius-xl` does not remove `rounded-xl`, it hands it back to
   Tailwind's 12px default, off the radius ramp. There is deliberately no
   named spacing scale — `p-sm` and `p-3` were the same 12px reached two ways,
   and the numeric scale is the one that maps 1:1 onto `--sp-N`.
4. **`base.css`** — html/body reset (root `font-size: 87.5%`, so 1rem =
   14px), the `:focus-visible` contract, `::selection` and the skip link, the
   base `--font-features` recipe, `--touch-target` (44px), the shared
   keyframes (`pulse-ring`, `blink`, `rise`), and the shared utilities
   (`.tnum`, `.code`, `.eyebrow`, `.tone-*`, `.rail-row`, `.ink-dim` /
   `.ink-strong`).

   `.tnum` and `.code` are deliberately two names, not one. `.tnum` gives
   tabular figures in the reading face — counts, timestamps, ratios, sizes.
   `.code` gives the mono face to literal strings the operator could type,
   paste, or diff — node ids, `@handles`, emails, workspace paths,
   credentials. Because `.code` supplies a family and weight rather than a full font role, a companion rule
   using the `font` shorthand resets it; those sites carry an explicit
   `.<class>.code` override.

**Naming rule:** component CSS only ever references a palette token
(`--surface-*`, `--ink-*`, `--line-*`, `--action*`,
`--ok/--warn/--err/--info`, `--live`, `--link-blue*`, `--code-*`, `--r-*`,
`--opacity-*`, `--sp-*`, `--control-h*`, `--card-h-*`, `--icon-*`,
`--avatar-*`, `--dot*`, `--measure*`, `--fs-*`, `--leading-*`, `--track-*`,
`--font-*`, `--z-*`, `--t-*`, `--rise*`, `--ease`, the shell widths) or a role
(`--type-*`, `--shadow-*`, `--focus-*`, `--link*`, and the interaction roles
above) — never a literal hex/`rgb()`/`hsl()`. New colours are mixed with
`color-mix(in srgb, var(--token) N%, transparent)`.

**No exceptions.** `web/.stylelintrc.json` grants exactly one file-level
override — `palette.css`, which originates colour by definition. Every other
stylesheet consumes tokens outright. `preferences.css`, `workspace-files.css`,
`a11y.css`, and `artifact.css` are **not** exceptions — they consume the
pinned `--dark-*` / `--light-*` / `--paper` tokens, which is exactly why those
tokens exist. `login.css` aliases the live register as local `--lg-*` names.

## Colors

Dark register / light register:

| Token | Dark | Light | Role |
|---|---|---|---|
| `--surface-0` | `#0a0a0a` | `#fafafa` | canvas |
| `--surface-1` | `#171717` | `#ffffff` | cards, panels |
| `--surface-2` | `#1f1f1f` | `#ebebeb` | fills, search, hover |
| `--surface-3` | `#262626` | `#ffffff` | drawers, modals, popovers |
| `--surface-rail` / `--surface-list` | `#1f1f1f` / `#171717` | `#f0f0f0` / `#f5f5f5` | shell zones |
| `--ink-1` | `#ededed` | `#171717` | headings, emphasis |
| `--ink-2` | `#d4d4d4` | `#262626` | body |
| `--ink-3` | `#b3b3b3` | `#525252` | secondary labels |
| `--ink-4` | `#a1a1a1` | `#666666` | timestamps, meta |
| `--line-1` | `#333333` | `#d4d4d4` | structural hairline |
| `--line-2` | `#292929` | `#e5e5e5` | soft hairline |
| `--cta-fill` / `--cta-hover` | `#ededed` / `#d4d4d4` | `#171717` / `#383838` | neutral inverted fill (composer send, landing CTA, profile-image hover disc) — not the default Button |
| `--cta-ink` | `#0a0a0a` | `#ffffff` | text on the neutral inverted fill |
| `--action` | `#7194fe` | `#2a44d3` | primary action + selection — periwinkle on dark, deep ultramarine on light |
| `--action-hover` | `#90aefe` | `#2237af` | pressed fill — moves away from the canvas |
| `--on-action` | `#0a0a0a` | `#ffffff` | ink on the action fill |
| `--action-soft` | 10% accent wash | 10% accent wash | selection wash, active nav |
| `--link` / `--link-hover` | `#a2bcff` / `#c3d4fd` | `#3e57a6` / `#2239a1` | anchors in prose, focus ring |
| `--ok` | `#4ac16a` | `#12752f` | ready, passed, done |
| `--warn` | `#fc9f30` | `#8f560f` | attention, degraded — amber, not the highlighter yellow |
| `--err` | `#ff6367` | `#c81232` | failed, destructive |
| `--on-err` | `#0a0a0a` | `#ffffff` | text on the critical fill |
| `--info` | = `--ink-3` | = `--ink-3` | neutral notice |
| `--live` | `#cf7ef0` | `#a121ce` | an agent is working *right now* |
| `--scrim` | `rgba(0,0,0,.6)` | `rgba(23,23,23,.24)` | overlay scrim (one layer, achromatic) |

### The surface ladder runs both ways

In **dark** the ladder is elevation: 0 < 1 < 3 in perceived lift, with 2 as
the fill tier between card and drawer. **Light cannot reproduce that**,
because white is a ceiling you cannot build above — so cards and floating
chrome are both white (`--surface-1` = `--surface-3` = `#ffffff`) and separate
by hairline and the `--shadow-2` ring, with `--surface-2` deliberately
**recessed** below the canvas.

The **zone** surfaces run the other way from dark. Dark builds the shell up
from the canvas (lift means lighter there); in light the shell recedes —
`--surface-rail` `#f0f0f0` < `--surface-list` `#f5f5f5` < canvas `#fafafa` —
so lightness order becomes rail < list < canvas < card, the same order the eye
should travel. A search field or hover well recedes from white and emerges
from black; that inversion is correct, and only `--surface-2` does it. Do not
paint shaded section bands over the canvas.

### Contrast floors

Every tier that can carry text clears WCAG 1.4.3 against **the worst plane it
can land on**, not against the canvas. Ratios against that plane:

| | ink-1 | ink-2 | ink-3 | ink-4 | ok | warn | err |
|---|---|---|---|---|---|---|---|
| dark (vs `--surface-3`) | 12.93 | 10.21 | 7.22 | 5.86 | 6.58 | 7.31 | 5.21 |
| light (vs `--surface-2`) | 15.04 | 12.69 | 6.55 | 4.82 | 4.88 | 5.02 | 4.91 |

`paletteTokens.test.ts` computes these from the declared hexes rather than
pinning the hexes themselves, so a future palette move is checked for
*legibility* rather than for matching a list. The same test asserts each
status tone still reads as **its hue** (green leads in `--ok`, red in `--err`,
amber's channels descend r > g > b) — the deepening AA forced on the light
register must not turn a green into a grey.

`--action-soft` is not a hex: it is a `color-mix` of the ultramarine into
transparency, so the selection wash always tracks the action colour.

A **pinned group** (`--dark-canvas`, `--dark-surface`, `--dark-ink`,
`--dark-line`, plus `--light-canvas`, and `--paper` `#ffffff` for document
previews) mirrors the registers for chrome that must *not* follow the active
theme: the theme-picker swatches that show both registers at once
(`preferences.css`), the diff viewer (`workspace-files.css`), ink-fill chrome
(`a11y.css`), and artifact paper (`artifact.css`). The set is
consumer-driven — add a pin only with a caller. `paletteTokens.test.ts`
asserts each pinned token equals its live counterpart — the pins silently
drifted once already, which is the failure they exist to prevent.

Artifact chips are **monochrome** — kind is carried by the icon and the mono
kind label, not by hue.

### The accent scope rule

Two accents, two jobs, and they never trade places:

| ultramarine (`--action`) | purple (`--live`) |
|---|---|
| the primary action fill (default `Button`, one per view) | composer running indicator |
| the selected-row accent bar, active nav marker | |
| selection wash (`--action-soft`) | task + backlog running rows |
| checked checkbox / radio / switch, current pager page | agent stream activity, busy header |
| lead chevron of the brand mark | thread pulse, streaming rail node, trailing chevron of the brand mark |
| | status pill on a running agent/node (TonePill `live`), the running status icon, running row accents |


**`--live` means "an agent is working on this right now", and nothing else.**
It is an ink, a mark, a hairline, or a ring — never a fill or a wash. It may
be static where it labels a running thing (the running status icon, a
running row's accent, a "Busy" badge, the running composer's hairline, the
dashboard's running count), but a purple DOT always moves: every live dot
wears `live-ring`. Passive presence (online dot, idle node, login readiness)
stays neutral — a `--t-pulse-calm` loop never takes `--live`. The brand mark
is the one purple that labels nothing running; see the carve-outs below.

**Every live dot moves the same way.** The `live-ring` keyframe
(`tokens/base.css`) is Relay's signature beat: a hairline `--live` ring leaves
the dot's edge and fades as it grows — the handoff the logo draws. State
marks, avatar presence, and the dashboard's running count all wear it, on
transform and opacity only. Its static style is the settled halo, so under
reduced motion the ring rests visibly and "working" is still told by shape,
not colour alone. The thread-rail pip is the one exception: its subline is
`overflow: hidden` and would slice the ring, so it breathes in place on the
same `--t-pulse`. Larger live objects (the transcript rail node) keep
`pulse-ring` / `agent-rail-pulse`.

"Two accents" is a claim about **meaning**, not pigment. The carve-outs, all
deliberate — a reader who takes the rule literally will file them as bugs:

- **Link blue is wayfinding, not decoration**: anchors in prose (`--link`)
  and the focus ring (`--focus-outline`). It is never a fill, a status, or an
  action.
- **The brand mark carries both accents.** `favicon.svg` (dark register),
  `relay-mark.svg` (light register, source of `apple-touch-icon.png`), the
  wordmark `relay-logo.svg` (follows the viewer's scheme), and `RelayMark`'s
  `tone="brand"` (side nav, sign-in, landing, empty transcript) draw an
  `--action` lead chevron and a `--live` trailing chevron. It is the one
  static use of purple: the mark depicts the handoff, it does not report a
  run. `RelayMark` inside working UI (transcript phase separators, generic
  empty states) keeps the default ink tone.
- **Identity marks are neutral.** Agents and teams render as neutral class
  glyphs (`IdentityMark.tsx`) — no procedural per-name hues. Identity is
  carried by glyph shape, never *what is happening*.
- **Syntax highlighting is a reading aid.** The five `--code-*` roles are the
  one place hue carries structure rather than meaning; they never appear
  outside a `code.hljs` block.
- **Login is a marketing surface.** It follows the saved theme (the layout's
  theme script sets `data-theme` before first paint; `login.css` aliases the
  live register as `--lg-*`). Its primary CTA (`.login-submit`) repaints the
  default Button as the neutral ink plate (`--ink-1` fill, canvas ink) rather
  than ultramarine. The screen sets its field labels, error line, and footer meta
  in the mono face — a deliberate skin; everywhere else mono is technical
  text only.
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

`--font-sans` is a system stack, in this order: `-apple-system,
BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial`,
then the Simplified Chinese faces (`"PingFang SC"`, `"Microsoft YaHei UI"`,
`"Microsoft YaHei"`, `"Noto Sans CJK SC"`, `"Noto Sans SC"`), `sans-serif`, and
the color-emoji faces. No sans font is downloaded, so reading text never swaps
after first paint and the build needs no font package.

The display face is chosen by **content origin, not by size**: a fixed UI noun
(Threads, Backlog, the wordmark, a drawer title) takes the display tier, while
a string written by a person or an agent takes its calmer content sibling —
the source system's editorial-subhead move, where a lighter weight at a display size
introduces visual rest.

| Role | Spec | Paired track | Use |
|---|---|---|---|
| `--type-display` | 500 28/1.17 | `--track-display` (−0.02em) | hero headline (login), admin metric values |
| `--type-page` | 500 22/1.25 | `--track-display` (−0.02em) | page h1 — one rung above the 17px h2 |
| `--type-title` | 500 17/1.25 | `--track-display` (−0.02em) | fixed-noun h2: rail titles, section headers, drawer and dialog titles |
| `--type-heading` | 700 15/1.44 | `--track-0` | section heads, list labels |
| `--type-title-content` | 400 16/1.25 | `--track-display` (−0.02em) | titles whose text comes from a user or agent |
| `--type-body` | 400 14/1.5 | `--track-body` (0) | prose, message bodies, inputs |
| `--type-name` | 500 14/1.5 | `--track-body` (0) | the identity of the thing a row or card is about — leads by `--ink-1` against `--ink-3` meta, not by weight |
| `--type-body-sm` | 400 12/1.43 | `--track-body-sm` (0) | supporting text, captions |
| `--type-label` | 500 12/1.43 | `--track-body-sm` (0) | chrome labels, nav, metadata |
| `--type-label-strong` | 700 12/1.43 | `--track-body-sm` (0) | bold chrome (scarce emphasis) |
| `--type-micro` | 500 12/1.33 | `--track-0` | structural group labels (lane, band, field) in **sentence case** — separated from `--type-label` by dimmer ink and line box, not weight or case |
| `--type-meta` | 500 12/1.33 | `--track-body-sm` (0) | sentence-case row meta, eyebrows, kickers |
| `--type-number` | 500 22/1.28 | `--track-display` (−0.02em) | metrics |
| `--type-code` | 400 14/1.43 | `--track-0` | commands, logs, IDs |

**Heading ladders.** Chrome headings map one size per level: page h1 =
`--type-page` (22/500); every fixed-noun h2 — list rails (thread list,
rosters, `.sec-rail`), section headers, drawers, dialogs — = `--type-title`
(17/500); section head h3 = `--type-heading` (15/700). Record titles
(user/agent-authored) take `--type-title-content` (16/400). Content headings
(`.md-body`, `.doc-prose`) run one six-rung ladder under the 17px chrome h2 —
h1 16/700, h2 15/700, h3 14/700, h4 14/500, h5 12/700, h6 12/500 — weight
splitting the shared sizes, so a content heading never rivals chrome.

**Every role ships a paired `--type-<role>-track`.** The `font:` shorthand
cannot carry `letter-spacing`, so a role applied as `font: var(--type-title)`
silently loses its tracking unless the call site remembers a second
declaration — pairing the tokens by name makes the omission greppable. Every
call site pairs them, even where the track is 0, so a role nested in a
display-tier parent never inherits −0.02em; `typographyTokens.test.ts` enforces
the pairing on display-tier rules. A role may take a different
`--leading-*` token at its call site (looser prose in a caption-sized box);
it may not take a different size or weight — that is a different role.

**Reading text sets solid; display tightens half a step.** The platform UI
faces carry per-size tracking of their own, so the reading tracks
(`--track-body`, `--track-body-sm`) are 0. The display tier takes
`--track-display` −0.02em (~0.5px at 28px) so titles and numerals settle.
`--track-caps` 0.03em is read only by short codes that are not translated
copy — the login skin's mono labels and the language badge's locale codes
(`.pref-lang-badge`); group labels went sentence case (2026-10-09), and `.eyebrow` /
`.page-header-kicker` must stay sentence case because they carry arbitrary
translated copy (`typographyTokens.test.ts` pins that). Under
`html:lang(zh-CN)` every track is 0. The tokens stay explicit so a
role's tracking is decided in `roles.css`, once.

**No stylistic set is switched on.** System faces assign `ss01`/`ss02`
differently (on San Francisco they redraw the 6, 9 and 4), so
`--font-features` is default kerning only (the vendored mono carries neither
set, so code is unaffected). It stays a token because
`font-feature-settings` replaces rather than adds: a rule that wants tabular
figures writes `var(--font-features), "tnum" 1`.

**There is no 800 role.** The system faces support it, but Relay deliberately exposes
only the 400/500/700 product ladder. The heaviest product weight already belongs
to the small emphasis tiers, while display tiers sit at 500.

The size ladder is **12 / 14 / 15 / 16 / 17 / 22 / 28px** at the browser's
default font size: `--fs-1` 12, `--fs-2` = `--fs-3` = `--fs-4` 14 (chrome,
dense prose, and body share the compact reading size; they stay three tokens
so a rung can move alone), `--fs-heading` 15, `--fs-title` 16,
`--fs-title-lg` 17, `--fs-5` 22, `--fs-6` 28. There is no 19px rung. All
sizes use rem; the root is 87.5% (14px by default), so user font preferences
scale type, and `typographyTokens.test.ts` pins every rung's pixel value. The
hero size (`--fs-hero`) clamps between 22 and 36px and never joins the ladder.
The transcript reads `--fs-transcript` (= `--fs-2`, 14px) at
`--leading-transcript` (1.65). Code is not a rung of that ladder: code
surfaces read `--fs-code` (14px monospace), and code inside the transcript
steps down to `--fs-code-transcript` (13px), so the sans rungs can move
without dragging the code face with them.

**`--track-display` must be applied to every display-tier rule** — via the
role's paired track token or directly. Display-tier means *two* shapes, and
both are swept by the test:

1. rules using a `--type-display` / `title` / `heading` / `number` role, and
2. rules that opt into `font-family: var(--font-display)` by hand.

A second `letter-spacing` in the same rule silently overrides the first, so
the sweep requires exactly one correct declaration per display-tier rule,
and a role rule must name its *own* paired token (`--type-title-track`, not
`--track-display`).

**CJK:** Relay ships English and Simplified Chinese. `html:lang(zh-CN)` does
not fork the sans stack — Latin sets in the platform UI face and Han falls
through to the Simplified Chinese faces named in the root stack, which also
covers agent-authored Chinese inside an English UI. The locale block changes
metrics: every track is pinned to 0 because Han glyphs are square and must
never be tightened, and reading leading loosens to 1.7/1.8/1.9. A language
preference saved as `zh-TW` while Traditional Chinese was offered reads as
`zh-CN` (`normalizeLanguage` in `web/src/lib/appStorage.ts`,
`normalize_user_language` in `backend/relay/security/auth_rows.py`).

JetBrains Mono is vendored as a **latin** variable subset
(`web/src/app/fonts/JetBrainsMono-Variable.woff2` with its OFL licence, wght
100–800), loaded by `app/layout.tsx` as `--font-app-mono`. Technical CJK
glyphs fall through to the system and Noto Mono CJK faces named in the mono
stacks.

## Geometry, elevation, motion

- **Radii:** `--r-1` 4px for micro details; `--r-2` 6px for controls,
  tabs, and badges; `--r-3` 8px for cards, drawers, dialogs, and panels.
  `--r-full` is 9999px for actual circles/capsules. Tailwind's larger radius
  names clamp to `--r-3`, and the bare `rounded` is pinned to `--r-1`; they
  do not introduce additional geometry. One documented exception: the
  composer's input well (`--composer-radius`, 2.5 × `--r-3`, reused as the
  awaiting-input dock's inset) — the one soft surface the eye returns to.
- **Spacing:** 4px base — `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4`
  16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-7` 32 · `--sp-8` 48. The scale stops
  there: the source system's 64/80px section rungs shipped with no call site
  and were removed. Below
  the base sit exactly two micro steps, `--sp-0-5` 2 and `--sp-1-5` 6, for
  glyph-tight pairs (dot ↔ label, icon ↔ text, stacked meta lines). They are
  the only sanctioned sub-4px gaps (`--sp-hairline` 0.5px is a hairline
  width, never a gap). Tailwind's numeric scale is pinned to `--sp-1`, so
  `p-3` is exactly `--sp-3`; the only legal half-steps are `.5` and `1.5`.
  Vendored registry code (`components/reui`) keeps upstream half-steps and is
  lint-exempt; Relay-authored markup follows the rule.
  `--sp-row` (16px, compact 12px via `[data-density="compact"]`) sets row
  rhythm; `--page-gutter` (32px, 24px at ≤ 820px) insets page chrome.
- **Control heights:** a compact desktop ladder — `--control-h-2xs` 24 ·
  `--control-h-xs` 28 · `--control-h-sm` 32 · `--control-h` **36** ·
  `--control-h-lg` 40px. Pick by what the control sits in (inline glyph →
  dense row chrome → standalone compact → field/primary → hero pair); a
  height off the ladder means the control is mis-classified. Coarse pointers
  raise every interactive element to `--touch-target` 44px (`a11y.css`).
- **Density:** `[data-density="compact"]` tightens genuinely dense surfaces
  (tables and list layouts): `--sp-row` 16 → 12px, body and name leading
  1.5 → 1.43, `--leading-loose` 1.65 → 1.5, and shorter record cards
  (`--card-h-tile` 116, `--card-h-fleet` 196). It maps `--fs-4` onto `--fs-3`,
  which are both 14px today, so it does not currently change type size. Put
  the attribute on the dense container, not the page. It **restates every
  role built on `--fs-4`** (`--type-body`, `--type-name`, `--type-body-sm`,
  plus the `zh-CN` variants), because a custom property resolves `var()`
  where it is *declared*, not where it inherits. Add a restatement whenever a
  new role uses `--fs-4`.
- **Atom sizes:** status dots `--dot-sm` 6 (in a chip) · `--dot` 8 (a row's
  pip) · `--dot-lg` 10 (presence on an avatar); avatars `--avatar-xs`…`3xl`
  (20–80px); CSS-drawn glyphs `--icon-*`, mirrored by `ICON` in
  `components/icons.tsx`; record cards `--card-h-*`. `dimensionScales.test.ts`
  holds each to its scale.
- **Opacity:** a state scale only — `--opacity-disabled` 0.6,
  `--opacity-dormant` 0.55, `--opacity-ghost` 0.45, `--opacity-mark` 0.8,
  `--opacity-underlay` 0.92. Opacity never dims text: a quieter label is an
  `--ink-*` tier (`paletteTokens.test.ts` fails a rule that sets `color` and
  opacity < 1).
- **Elevation:** flat. `--shadow-1` is `none`; `--shadow-2` is a 0.5px
  `--line-1` ring without blur. Cards separate by surface and border;
  floating dialogs, drawers, menus, tooltips, and toasts share the ring.
  Blurless `inset` box-shadows are rings, not elevation, and are allowed for
  hairlines and selection marks (`--accent-bar` is one); an offset or blurred
  shadow is not. The landing page's sticky nav is the one `backdrop-filter`
  — a marketing surface, like the login cover.
- **Focus:** `--focus-outline` — a 2px solid **link-blue** ring at a 2px
  offset (WCAG 1.4.11), drawn with `outline`, **not** `box-shadow`, so no
  ancestor's `overflow: hidden` can clip it and forced-colors mode preserves
  it. The ring is not the ultramarine action, so a focused primary button never
  rings in more of its own fill. Destructive controls take
  `--focus-outline-danger`, which differs by **both** colour (`--err`) and
  shape (dashed) — the stroke style is the half that survives forced-colors
  mode, where the hue is dropped. A field inside a composite control (search
  box with a clear button, the composer well) suppresses its own ring and the
  wrapper draws the same outline on `:focus-within` — one ring per control,
  never two, and never a ultramarine border inside it. The composer well is the one
  exception: its caret is the focus cue, so the well darkens its own border to
  `--ink-4` instead of ringing (a 2px ring on its 20px corner read as an
  error); its footer pickers still ring normally.
- **Measure:** the reading-column cap, in `ch` — `--measure-tight` 34
  (captions, empty-state lines), `--measure` 48 (the default),
  `--measure-wide` 72 (long-form agent prose). Anything narrower is a layout
  width, not a measure: give it px and a reason.
- **Z layers:** three tiers, all with consumers — `--z-drawer` 30 ·
  `--z-dialog` 300 · `--z-float` 400. Menus, selects, popovers, tooltips and
  drag ghosts all sit on `--z-float`, above dialogs, because anchored chrome
  must float over the surface it was opened from. There is deliberately no
  `popover` tier below `drawer`. Two derived layers sit on these: stacked
  drawers add their depth to `--z-drawer` (`Drawer.tsx`), and the toast
  viewport sits at `--z-dialog` + 1 so a notice is never hidden by the dialog
  that caused it. Bare `z-index: 1/2/3` (Tailwind `z-10` in primitives) orders
  siblings inside an already-positioned component and must not be promoted
  to tokens.
- **Motion:** `--ease` `cubic-bezier(0, 0, 0.2, 1)` (ease-out); `--t-fast`
  150ms, `--t-slow` 250ms — the source system publishes no timings and
  recommends 150–250ms for surface transitions. No spring, no overshoot.
  Tailwind's default transition timing and duration are pinned to `--ease`
  / `--t-fast` in `shadcn-bridge.css`, so a bare `transition` utility obeys
  them. Two loops are deliberately not eased: spinners rotate `linear` and
  the caret blinks in `steps()`.
  A theme switch is not a transition: `applyTheme` holds
  `html.theme-switching` for two frames, which turns transitions off so the
  page switches instead of cross-fading.
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
- **Keyframes:** `live-ring` (every live dot), `pulse-ring` (larger live
  objects and passive presence, tinted via `--pulse-color`), `blink` (glyphs
  that breathe in place), and `rise` live once in `base.css`;
  `spin` (`pills.css`, the `.spin` class) and the `overlay-*` fade/panel set
  (`overlay.css`) are the other shared sets, and the anchored tooltip/menu
  entrances in `base.css` are the one local carve-out. Do not hand-roll a
  second ring, fade, or entrance keyframe.

## Marginalia

Relay keeps one small decorative gesture: the **double-chevron mark** bled off
the lower-left corner of the login cover — hairline-weight linework at 4% ink,
fixed position — shipped as the inline `Chevrons` SVG in
`web/src/components/AuthCanvas.tsx` with the `.login-bleed` rule in
`login.css`. The rules:

- **Ink only.** The mark never takes an accent (action or live), never takes
  a status tone, never fills — strokes alone.
- **Never animate it.** It is set dressing in an operator tool;
  `prefers-reduced-motion` is trivially satisfied because there is no motion.
- **Absolutely positioned**, so it never perturbs the layout it decorates.
- One mark per surface. A second one on the same screen is clutter, not
  charm. The landing page carries its own (`landing.css`), on its own
  surface.

Empty states carry no decorative layer — no dashed construction plate, no crop
ticks, no corner doodles, no bled watermark glyph, no orbit ring. A zero-data
surface is a moment where the product has nothing to show; dressing it up
reads as apology. They are composed from type, spacing, and one optional mark
tile (`.relay-empty-avatar` in `empty-state.css`), shared by the centered
`RelayEmptyState` and the board and transcript variants.

## Do's and Don'ts

### Do
- Use the default `Button` (ultramarine `--action` via `--primary`) for the
  primary action, one per view; step every other button beside it down to
  `outline` or `ghost`.
- Use `--action` otherwise for selection — accent bars, checked controls, the
  current page — and pair a ultramarine fill with `--on-action`.
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
- Set type with a role — `font: var(--type-*)` plus its paired
  `letter-spacing: var(--type-*-track)` — at every site, even where the
  paired track is 0; the declaration is the contract. A one-off size reads a
  `--fs-*` rung, never a px/rem literal.
- Size controls from the `--control-h*` ladder (or the `Button` /
  `SelectTrigger` `size` prop), dots from `--dot*`, avatars from `--avatar-*`.
- Make quieter text a lower `--ink-*` tier; disable a whole control with
  `--opacity-disabled`, not a dedicated hex.
- Separate surfaces with fills and hairlines; floating chrome adds a ring, not blur.
- Add new raw values to `palette.css` and new roles to `roles.css` — never
  inline a colour in a component file (`npm run lint:css -w web` enforces).
- Time transitions with `--t-fast` / `--t-slow` and `--ease`, loops with
  `--t-pulse` / `--t-pulse-calm` / `--t-tick`, delays as multiples of
  `--t-stagger`; layer with `--z-drawer` / `--z-dialog` / `--z-float`.
- Reuse a registered breakpoint tier (`palette.css` header; `lib/breakpoints.ts`
  in JS) and add a registry row in the same change as any new query.

### Don't
- Don't use a status colour as an action, or ultramarine as a status or a link.
- Don't put a second filled ultramarine button in a view, or make a selected row a
  solid ultramarine fill — selection is the bar plus the 10% `--action-soft` wash.
- Don't introduce a third accent. Cobalt is the action and selection, purple
  is liveness, link blue is wayfinding; everywhere else the ink ramp is the
  only signal.
- Don't give controls pill corners (`--r-full` / `rounded-full`) or introduce
  radii beyond the 4/6/8px ladder.
- Don't set text or dots in a status tone taken straight from the source
  system's badge palette — those are *fill* values (success `#31a24c` measures 3.1:1
  on white, warning `#f7b928` 1.8:1). The tokens here are already the
  text-safe tuning; use them.
- Don't paint shaded section bands over the canvas — the page is one sheet.
- Don't fill backgrounds with status colours. The documented exceptions are
  the destructive hover inversion (and the destructive menu item's 10% `--err`
  highlight), the fleet-health bar segments, the 16% diff-row washes, the 8%
  tone tints on `Badge`'s status variants (text stays the AA tone), and the
  composer mention token's `--warn` hatch for an unavailable agent.
- Don't add elevation: no offset or blurred shadow beyond `--shadow-2`'s
  hairline ring (blurless inset rings are fine).
- Don't tint agent avatars with vendor brand colours — glyph shape carries
  identity.
- Don't add overshoot or extra easing curves — there is exactly one ease
  (plus `linear` spinners and the `steps()` caret).
- Don't colour artifact chips by kind — icon + label only.
- Don't paint a focus ring as a `box-shadow` — it is an `outline`, so it
  survives clipping ancestors and forced-colors mode.
- Don't hand-write a `ch` width for prose; reach for the `--measure*` tier.
- Don't add a size step off the `--fs-*` ladder, or a height off the
  `--control-h*` ladder — separate by weight or ink instead.
- Don't force `text-transform: uppercase` on translated copy — group labels,
  eyebrows, and kickers are sentence case (Han has no case to transform).
- Don't hand-pick a duration, delay, or `z-index` app layer; local `z-index:
  1/2/3` between siblings is the only literal allowed.
- Don't declare `font-weight: 800` — the Relay product ladder deliberately
  stops at 700 even though the system faces expose heavier weights.

## Shell dimensions

| Token | Value | Use |
|---|---|---|
| `--sidenav-w` | 72px | Collapsed left rail |
| `--sidenav-w-open` | 228px | Expanded left rail |
| `--thread-w` | 360px | Conversation list pane (floor `--thread-w-min` 240px) |
| `--space-w` | 384px | Thread space panel (floor `--space-w-min` 288px) |
| `--chat-w-min` | `min(420px, 48vw)` | Transcript floor |
| `--thread-measure` | 880px | Transcript/composer column cap, gutters included |
| `--header-h` | 52px | Shared page/pane header row (`.page-header`, thread space header) |
| `--page-gutter` | 32px (24px ≤ 820px) | Inline inset for page chrome |

Each resizable column is a floor (`-min`), a preferred width, and a viewport
cap (`-cap`, e.g. 18vw / 26vw / 30vw); the floors mirror the drag clamps in
`lib/{sidenav,threadList,threadSpace}.ts`, and `shellColumns.test.ts` fails
if either side moves alone.

## Responsive behaviour

Relay's breakpoint registry lives in a comment at the top of `palette.css` —
custom properties cannot drive `@media`, so that list is the only registry
there is, and it must be updated when a query is added. The app-wide tiers are
**820px** (mobile — the only phone tier, mirrored in JS as
`OVERLAY_TAKEOVER_QUERY` in `lib/breakpoints.ts`) and **1040px** (tablet);
everything else is a component tier (480 narrow phone and container ·
640 compact panes and container · 768 container only · 900 dashboard/backlog
medium, and where the space panel becomes an overlay · 1100 multi-pane →
single pane · 1200 dashboard widest, the narrowest four-column shell · 1400
thread metadata drops the computer chip). `designGrid.test.ts` checks the
registry in both directions across `@media` and `@container`: a query with no
row fails, and a row with no query fails. Two rules of thumb: a new query
reuses a tier above rather than inventing a neighbour, and one component gets
one breakpoint.

The source system's own tiers are marketing-page tiers (< 480 · 480–767 ·
768–1023 · 1024–1359 · ≥ 1360) and its collapsing rules are about heroes,
feature grids, and a PDP purchase rail Relay does not have. What carries over
is the *behaviour*: multi-column layouts collapse toward one column, side rails
become sticky bottom chrome, and display type steps down the ladder rather than
scaling continuously.

**Touch targets.** Desktop controls stay on the compact 24–40px ladder
(`--control-h` 36px). Under `@media (pointer: coarse)`, `a11y.css` raises
every interactive element — matched by tag, ARIA role, and `data-slot`, a
denylist rather than an allowlist — to `min-height: var(--touch-target)`
(44px), gives square icon buttons the floor on both axes, and sets form
fields to 16px so iOS does not zoom on focus. Opting a control out takes an
explicit entry in that file's exceptions block.


## Data visualization

Charts run on the ink ramp — a brightness ramp, not a hue ramp. The admin
token-usage chart stacks a three-step ink ramp of fresh tokens, dimmest at the
base: output = `--ink-2` (brightest — it is the product of the work), input =
`--ink-3`, cache writes = `--ink-4`. Cache reads are not charted, matching the
fresh-token headline. **No series may take
`--action`**: a ultramarine chart fill reads as "click me". Because the ramp
deliberately uses neighbouring ink steps, each segment carries a
`--surface-1` hairline stroke — adjacent steps of a monochrome ramp merge
into one flat band without it.

Fleet-health bars double-encode: the ink ramp alone cannot separate five
values in an 8px bar, so each segment's fill is its tone — running `--live`,
failed `--err`, stale a `--warn` hatch, ready `--ok`, unknown `--ink-4` — a
deliberate data-viz exception to "status is never a fill". `--live` also
marks the running node count, so the card's accent density is a utilisation
readout: live-carrying elements when work is in flight, none when idle.

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

| Control size | Token | Height | Button | SelectTrigger |
| --- | --- | --- | --- | --- |
| Inline | `--control-h-2xs` | 24px | `xs`, `icon-xs` | — |
| Dense row | `--control-h-xs` | 28px | `dense`, `icon-dense` | — |
| Small standalone | `--control-h-sm` | 32px | `sm`, `icon-sm` | `sm` |
| Default | `--control-h` | 36px | `default`, `icon`, `cta` | `default` |
| Large | `--control-h-lg` | 40px | `lg`, `icon-lg` | — |

Button labels are 12px/500 (`text-xs font-medium`) at every size; height and
padding separate the tiers. `dimensionScales.test.ts` keeps the primitive's
sizes on the ladder. Touch controls increase to the shared target floor;
compact visual controls use separate hit areas. Do not change row density as
a side effect of aligning API names.

### Agent turn

The transcript renders one agent turn as a stack of tiers, each identified by a
marker rather than by a frame. Raw JSONL never reaches the reader.

| Tier | Marker | Type | Ink |
| --- | --- | --- | --- |
| Answer (prose) | none | `--fs-transcript` at `--leading-transcript` | `--ink-1` |
| Reasoning | disclosure chevron | `--fs-2` header, `--fs-transcript` body at `--leading-loose` | `--ink-3` (step titles `--ink-2`, 500) |
| Tool / command | `--dot-sm` dot in `--ink-4` | `--fs-2`; commands mono at `--fs-code-transcript` | `--ink-2` (tool name `--ink-1`) |

The terminal renderer's `⏺` glyph is drawn as a CSS dot on the web because
the glyph falls back to the colour-emoji face in a browser. Consecutive tool
and command lines fold into one activity group.

- Reasoning is a **disclosure**, not a body of text with a toggle under it: a
  header row names the step, and the open body lists the steps under a hairline
  rule hung from the chevron's centre. A reasoning summary arrives as titled
  steps (Codex writes each as a bold title with an optional body), so the titles
  render as titles — never as `**` in the transcript.
- How many blocks a CLI emits is its own chunking, not the agent's train of
  thought, so adjacent reasoning merges into one disclosure. Only reasoning
  separated by real work — a tool call, a command, prose — starts a new one.
- The collapsed header names the step the thinking **started** with and counts
  the rest; a live one names the step the agent is on **now** and breathes on
  the shared `blink` keyframe. Live reasoning opens itself, because it is often
  the turn's only visible progress; a reader who opens or closes a block owns it
  from then on.
- Body lines stay verbatim: one line per paragraph, `pre-wrap`, never reflowed
  as Markdown — the model's own line breaks carry the structure.
- Disclosure headers and expanders are inline **text** affordances, not
  controls: bare `<button>`s that sit in their tier's ink and take the focus
  ring from base.css. A control-height `Button` in this position puts half a row
  of dead space under every collapsed block.

## Reviewing changes

Run `npm run dev -w web` and open `/dev/design-system` for a specimen composed
from the actual primitives. It uses no API records and returns not-found in
production. Use the light/dark controls, drawer, and toast actions to inspect
states. It is a focused control specimen, not a substitute for real-route review.

Run `npx playwright install chromium` once, then `npm run test:design -w web`
(`web/e2e/design-consistency.spec.ts` against the specimen, on its own dev
server at port 5017) for computed-style checks in desktop and touch Chromium,
in both themes. The suite covers select/switch chrome, Badge chip geometry,
tone edges, drawer and prompt field borders and focus, switch geometry on
touch, disabled opacity, small-control height parity, the menu keyboard
contract and popup surface, resize-handle keyboard and value contract, and
toast elevation/motion including reduced motion.
Keep the source-level token tests too (`web/tests/paletteTokens.test.ts`,
`typographyTokens.test.ts`, `designGrid.test.ts`, `dimensionScales.test.ts`,
`shellColumns.test.ts`, `designIssues.test.ts`) and `npm run lint:css -w web`:
they check vocabulary and ownership, while browser checks prove the styles
that actually win the cascade.

## Audit checklist

Each line is checkable against a diff or a computed style; the section that
explains it is in parentheses.

1. **Colour source.** No hex, `rgb()`, or `hsl()` outside `palette.css`;
   derived colours are `color-mix()` over tokens. (Token architecture)
2. **One primary per view.** At most one filled default `Button`
   (ultramarine `--primary`); its siblings are `outline` / `ghost` /
   `destructive`. `--cta-fill` appears only on the composer send, landing CTA,
   and profile-image hover disc. (Overview)
3. **Accent scope.** `--action` only for the primary fill and selection (bar,
   checked control, current page, `::selection`, skip link); selected rows use
   `--action-soft`, never a solid fill. `--live` only beside `--t-pulse`.
   `--link` only for prose anchors and the focus ring. (Accent scope rule)
4. **Status.** Status tones as text, dots, and borders; fills only in the
   documented exceptions. `--info` for neutral notices. (Colors)
5. **Type.** Text set with a `--type-*` role and its paired `-track`, or a
   `--fs-*` rung — no literal font sizes; weights only 400/500/700.
   (Typography)
6. **Case.** No `text-transform: uppercase` on translated copy. (Typography)
7. **Radius.** `--r-1` micro, `--r-2` controls, `--r-3` containers;
   `--r-full` only on true circles and capsules. (Geometry)
8. **Control heights.** Every control height is a `--control-h*` rung or a
   `Button` / `SelectTrigger` size; touch reaches 44px via `a11y.css`.
   (Shared component contracts)
9. **Focus.** Ring drawn with `outline: var(--focus-outline)` (or
   `--focus-outline-danger`) at `--focus-offset`, never `box-shadow` or a
   Tailwind `ring-*`, and only through the base or primitive contract — or a
   composite's `:focus-within` wrapper, with the inner field's ring
   suppressed. One ring per control. (Geometry)
10. **Elevation.** No offset or blurred shadow other than `--shadow-1` /
    `--shadow-2`; blurless inset rings are allowed. (Geometry)
11. **Motion.** Durations, loops, and delays from `--t-*` and `--ease`;
    entrances use `rise`; liveness changes are checked under
    `prefers-reduced-motion`. (Geometry)
12. **Layout.** Spacing from `--sp-*` (or the 4px numeric utilities),
    reading widths from `--measure*`, app layers from `--z-*`. (Geometry)
13. **Breakpoints.** Every `@media` / `@container` width — including a
    Tailwind responsive variant in markup (`sm:` is 640px, `md:` 768px) — is
    a row in the `palette.css` registry; phone layout is 820px.
    `designGrid.test.ts` sweeps CSS only, so check variants by eye.
    (Responsive behaviour)
14. **Opacity.** No opacity on a rule that also sets text colour; disabled is
    `--opacity-disabled`. (Geometry)
15. **Both registers.** The change is reviewed in light and dark, and in
    `en` and `zh-CN` where copy changes. (Overview, Typography)

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
| `primary` / `primary-deep` / `on-primary` | `--action` / `--action-hover` / `--on-action` | Retuned per register and moved 10° toward violet (ultramarine, oklch 268): `#7194fe` / `#90aefe` with dark ink on the dark canvas, `#2a44d3` / `#2237af` with white on the light one. Relay is entirely in-product, so the accent is *the* action rather than a commerce-only variant. The published `#0064e0` no longer appears anywhere. |
| `ink-button` / `on-ink-button` | `--cta-fill` / `--cta-ink` | Kept as a neutral inverted fill (`#ededed` on dark, `#171717` on light) for the composer send and profile-image hover disc — not the default Button. |
| `primary-soft` | `--action-soft` | Carried as a `color-mix` wash rather than a flat hex, so the selection tint tracks the action colour. |
| `meta-link` | `--link-blue` (light) | Verbatim. Dark lifts it to `#8ab4f8` for AA on the ink-deep canvas. |
| `oculus-purple` | `--live` | Verbatim in light, lifted in dark. Relay spends the second sanctioned accent on liveness because cobalt is already the action. |
| `success` / `warning` / `critical` | `--ok` / `--warn` / `--err` | Hue family kept; lightness retuned per register so each clears 4.5:1 as *small text* — the published values are badge-fill colours. The warning additionally walks from the published golden yellow (hue 82) to an amber at hue 65, so a caution stops out-shouting the critical red beside it and keeps 43° of clearance from it. |
| `canvas` / `surface-soft` | `--surface-1`, `--surface-3` / `--surface-2` | White carries cards and floating chrome in light; the page is Geist's `#fafafa` (`--surface-0`) and the recessed fill is an achromatic `#ebebeb`. The cool `#f1f4f7` grey is not used. |
| `ink-deep` / `ink` / `charcoal` | `--ink-1` / `--ink-2` / `--ink-3` | Replaced by Geist's achromatic ramp (`#171717` / `#262626` / `#525252` in light). |
| `steel` | `--ink-4` | Replaced by `#666666` in light, the lightest grey that still clears AA on the recessed fill. |
| `stone` / `disabled-text` | — | Not adopted. Disabled is opacity in Relay, so a dedicated disabled ink has no consumer. |
| `hairline` / `hairline-soft` | `--line-1` / `--line-2` | Achromatic in both registers (`#d4d4d4` / `#e5e5e5` light, `#333333` / `#292929` dark). |
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

**What Relay does with it:** the ladder above collapses to the compact app
ladder 12 / 14 / 15 / 16 / 17 / 22 / 28 plus a hero clamp (see Typography).
The 28px/300 editorial tier is not adopted as a size — Relay expresses the
same "visual rest" idea as `--type-title-content` (16px/400), because a dense operator tool has no editorial intro headlines. The
proprietary source face is not redistributable, so Relay uses the platform UI
face instead. The product keeps only the 400/500/700 rungs; 300 and 800 remain
outside the role system even though the system faces support them.

## Source layout scales

**Spacing** — 4px base with 8px as the dominant step: 4 · 8 · 10 · 12 · 16 ·
20 · 24 · 32 · 40 · 48 · 64 · 80 · 120. Marketing sections separate at 80px,
product-detail sections at 64px, FAQ stacks at 32px. Card padding is 32px
standard, 24px for icon-feature tiles, 64px for promo strips. Relay adopts the
4 · 8 · 12 · 16 · 20 · 24 · 32 · 48 and drops 10 (off the 4px grid), 40,
64, 80, and 120 (marketing section gutters with no in-app consumer); it adds
nothing below 4px except its two documented micro steps.

**Grid** — marketing pages cap near 1280px with 32–48px gutters; the PDP is a
58/42 split with a `max-width: 380px` sticky purchase rail; three-up feature
grids use a 24px column gap and six-up thumbnail rows a 12px gap. Relay's
equivalent caps are `--thread-measure` (880px) and the `--measure*` reading
tiers.

**Radii** — 2 · 4 · 6 · 8 · 16 · 24 · 32 · 40 · 100 (pill) · 50% (circle).
Product hero photography sits in 32px frames; square thumbnails take 16px;
selection-grid tiles take 8px, deliberately tighter than showcase frames;
swatches are 32px circles with a 2px white ring when selected. Relay keeps
only 4 / 6 / 8 plus `--r-full` for true circles (see Geometry) — the larger
rungs serve photographic and marketing surfaces the app does not have, and
the pill is not a control shape here.

**Elevation** — three levels, only two of which are shadows:

| Level | Treatment | Use |
|---|---|---|
| 0 (flat) | No shadow; 32px rounding + hairline-soft border | Product cards, why-buy tiles |
| 1 (subtle) | `rgba(0,0,0,0.2) 1px 1px 0 0` | Pill-tab activation indicator |
| 2 (sticky panel) | `rgba(20,22,26,0.3) 0 1px 4px 0` | PDP purchase summary, sticky mobile checkout bar |

Relay wires level 0 to `--shadow-1` (`none`) and level 2 to `--shadow-2`, a
0.5px `--line-1` ring with no blur. Level 1 has no Relay consumer — its job
is a pill-tab active state, which Relay signals with an underline or the
selection wash instead.

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
  colour scarce — one filled cobalt button per view.)*
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
   a near-black `#0a0a0a` canvas, an achromatic grey elevation ladder above
   it, and a lighter ultramarine (`#7194fe`) carrying dark ink. Every
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
