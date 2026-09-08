# Frontend consistency audit

Date: 2026-09-09. Original source review; the subsequent fixes and verification are recorded in `docs/testing/frontend-consistency.tdd.md`.

## Scope and conclusion

Inventoried and scanned all 53 CSS files and 163 TSX files under `web/src`, including 25 shared UI primitive files. Reviewed token definitions, imports/cascade, shared controls, status treatments, overlays, navigation, typography, motion, responsive rules, and their consumers across threads/composer, backlog/routines, agents, teams/projects/workspaces, computers, channels, admin/dashboard, login, preferences, and artifacts.

The existing system is already substantially consolidated: centralized colors and scales, shared Button/Badge/Card/Field primitives, a common icon vocabulary, shared dialog behavior, responsive tiers, and reduced-motion support. The largest remaining issues are effective CSS behavior and gaps between the written system and component implementations. A new visual identity is unnecessary to address them.

This is a source audit, not a rendered walkthrough of every route. Findings about computed styles follow the declared cascade and custom-property scopes; they still need browser regression coverage. Dependencies are not installed in this checkout, so no application build, CSS lint, or browser suite was run.

## Prioritized findings

### 1. P1 — Native-button reset removes shared control chrome

Evidence: `web/src/styles/tokens/base.css:144`, `web/src/styles.css:14`, `web/src/components/ui/select.tsx:44`, `web/src/components/ui/switch.tsx:17`.

`button:not([data-slot="button"])` sets `border: 0; background: none`. It excludes only the Button primitive, so button-rendered controls with other slots, including SelectTrigger, match it. The reset lives in the `relay` layer after Tailwind utilities; their border/fill utilities lose even when the utility has greater specificity. This makes fields depend on where a route happens to repaint them. Verification of the installed Base UI implementation confirmed that Switch and Checkbox render spans by default, so the native-button reset does not affect those default roots; the switch has a separate touch-geometry issue below. The neighboring font reset already excludes all slotted controls, but the paint reset does not.

Fix: limit native paint/press/disabled resets to genuinely unstyled controls, and let shared primitives own their state styles. Verify SelectTrigger and switch states with computed styles in both themes, inside and outside drawers. Do not try to repair this by adding increasingly specific Tailwind classes: layer order wins first.

### 2. P2 — Status-border token resolves outside the status scope

Evidence: `web/src/styles/tokens/roles.css:51`, `web/src/styles/tokens/base.css:304`, `web/src/styles/task-status.css:208`, `web/src/components/ui/badge.tsx:41`, `web/src/components/ui/alert.tsx:29`.

`--tone-line` is declared on `:root` using `var(--tone, var(--ink-1))`. Components supply `--tone` on descendants. Custom-property substitutions resolve where a property is declared, so the inherited border value has already used the neutral fallback; supplying a local tone does not recompute it. Routine badge borders, alert borders, and other status edges therefore cannot follow their intended local hue, even while their marks do.

Fix: compose the derived border in the scope where the component supplies its tone, through a shared status treatment or explicit local composition. Test actual border colors for warning, error, live, and neutral consumers; source checks for token names cannot prove this behavior.

### 3. P2 — Overlay forms replace the shared control boundary with a structural hairline

Evidence: `web/src/styles/admin-v2-drawers.css:231`, `web/src/styles/dialog.css:80`, `web/src/styles/tokens/roles.css:75`, `web/src/components/ui/input.tsx:13`.

Shared inputs use `--control-border`, but drawer descendants replace it with `--line-1`, and dialog inputs write that hairline directly. This changes the visual affordance of the same field between page and overlay. Drawer overrides also beat utility-driven invalid/focus border colors because they are in the later layer. The system explicitly distinguishes structural seams from control boundaries; overlays currently undo that distinction.

Fix: keep the overlay fill role, retain the shared control-border role, and preserve primitive focus/invalid states. Express intentional overlay differences as a supported field variant rather than broad descendant overrides.

### 4. P2 — Toasts retain a separate elevation and motion system

Evidence: `web/src/components/ui/toast.tsx:55`, `web/src/components/ui/toast.tsx:57`, `web/src/components/ui/toast.tsx:83`, `web/src/styles/tokens/roles.css:22`.

Toast uses `shadow-lg`, a 500ms transform/opacity transition, and `cubic-bezier(0.22,1,0.36,1)`. Other floating surfaces use the flat `--shadow-2` border ring and shared motion tokens. The result is a visibly different depth and movement model for a frequently displayed shared component. Its `rounded-2xl` is not itself a radius bug: the bridge maps it to the existing container radius.

Fix: preserve the toast stack/swipe geometry, but route elevation, duration, and easing through the shared roles. If stack movement needs a distinct duration, define and document that role explicitly. Check stacking, dismissal, and reduced motion after changing it.

### 5. P2 — Touch-target expansion changes the switch drawing

Evidence: `web/src/styles/a11y.css:81`, `web/src/styles/a11y.css:93`, `web/src/components/ui/switch.tsx:17`.

The switch deliberately draws a 36-by-20px track, with a pseudo-element extending its hit area. The coarse-pointer rule also applies `min-height: 44px` to `[role="switch"]`. That changes the visible track to at least 44px tall while width and thumb travel remain sized for the compact track. Pointer type thus changes the component silhouette instead of only its target area.

Fix: separate the switch hit target from its visible track, or explicitly exempt the track once its external target is guaranteed. Verify checked/unchecked geometry under coarse-pointer emulation. Audit checkbox/radio target geometry alongside it without assuming every Base UI primitive renders the same tag.

### 6. P3 — Disabled-state styling bypasses the shared opacity token

Evidence: `web/src/styles/tokens/palette.css:296`, `web/src/styles/tokens/base.css:150`, `web/src/components/ui/button.tsx:10`, `web/src/components/ui/input.tsx:13`, `web/src/components/ui/tabs.tsx:43`.

The palette defines `--opacity-disabled: 0.6`, and native/component CSS consumes it, while many shared primitives hardcode `opacity-50`. The same disabled affordance therefore has two strengths, and changing the token updates only part of the UI. Filled Button variants intentionally use replacement fills at full opacity; retain that deliberate treatment.

Fix: use the opacity token for ordinary disabled primitives and document the filled/destructive exceptions. Include disabled and loading states in a common component specimen.

### 7. P3 — Control size names do not mean the same size across primitives

Evidence: `web/src/components/ui/button.tsx:68`, `web/src/components/ui/select.tsx:44`, `web/src/styles/tokens/palette.css:373`.

Button `size="sm"` uses `--control-h-xs` (32px), whereas SelectTrigger `size="sm"` uses `--control-h-sm` (40px). Both heights are legitimate system tiers, but the public API gives the same name two meanings. This makes composed compact toolbars/forms need local corrections and encourages continued CSS overrides.

Fix: establish shared semantic size names such as inline, dense, compact, and default, with one mapping per height. Migrate paired controls deliberately; do not blindly enlarge every existing small row action.

### 8. P2 — The documented design system contradicts the implemented geometry

Evidence: `docs/design-system.md:16`, `docs/design-system.md:73`, `web/src/styles/tokens/palette.css:241`, `web/src/components/ui/button.tsx:10`, `web/src/styles/tokens/roles.css:22`.

The document says every button, tab, and badge is a pill and containers use a 4/8/16/24/32 radius ladder. Executable tokens instead define 4/6/8px, explicitly reserve full rounding for circles/capsules, and use a flat elevation model. This is an actionable maintenance problem: a contributor following the claimed source of truth would reintroduce the styles the code prohibits. Other stale comments describe current 13px labels as 14px and the display header as monospace.

Fix: document the current Relay system as the normative specification. Keep the imported commerce reference clearly historical/inspirational, with explicit adaptations. Align component comments and size tables with the executable tokens.

## Coverage by design category

| Category | Assessment / next action |
| --- | --- |
| Color and themes | Strong centralized palette; repair local status-token evaluation and overlay border overrides. Render both themes before claiming contrast coverage. |
| Typography | Shared families and roles are established; existing typography checks pass. Clean up stale size/face descriptions. Preserve CJK and compact-density accommodations. |
| Spacing and geometry | Existing grid/radius guards pass. Unify control size API meanings; correct coarse-pointer switch geometry. |
| Components | Shared primitives are widely used. Prioritize cascade ownership over introducing more wrappers. |
| Status and feedback | Central marks/tones exist; fix tone-border evaluation and align toast treatment. |
| Layout and responsiveness | Registered media/container tiers and mobile overrides exist. Render at 320/375/820/1040px and with touch input; source checks cannot establish absence of overlap or clipping. |
| Icons and identity | Existing icon-system checks pass; preserve the current shared vocabulary. |
| Overlays and focus | Dialog primitives centralize behavior. Validate actual field, focus, invalid, and disabled appearance after reset cleanup. |
| Motion | Reduced-motion safety net exists; toast is a concrete exception to normal motion/elevation rules. |
| Governance | Align written rules with tokens and add computed-style coverage for shared states. |

## Consolidation order

1. Fix cascade ownership and status-token scope first. These affect many surfaces without needing a redesign.
2. Align overlay fields, switch hit targets, and toast roles.
3. Normalize disabled tokens and control size APIs while preserving deliberate density differences.
4. Update the normative design document and remove obsolete comments.
5. Add a development-only component specimen using the real components and tokens: controls, badges, alerts, cards, tabs, search, dialogs, drawers, and toasts in their relevant states. Pair it with browser assertions for effective styles, then check representative real routes. Do not introduce fake server data.

## Verification performed

Ran:

```sh
node --test web/tests/designGrid.test.ts web/tests/typographyTokens.test.ts web/tests/toneDriver.test.ts web/tests/iconSystem.test.ts web/tests/overlayPrimitive.test.ts web/tests/faceUtilities.test.ts
```

Result: **43 tests passed, 0 failed**. These are source/asset checks; they do not verify browser computed styles. Their passing result alongside the findings above demonstrates the coverage gap, not visual correctness.

A scan of CSS variable references found only runtime-provided/fallback variables outside CSS definitions (font-loader variables, drawer width, avatar size, and member animation index); no additional missing CSS token definition was identified by that scan.
