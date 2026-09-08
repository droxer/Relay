# Frontend consistency verification

The journeys were derived from the eight findings in
[the frontend audit](../frontend-consistency-audit.md): an operator should see
consistent controls, semantic borders, sizes, disabled states, and floating
surfaces across themes and pointer types. No external resources were changed.

## Changes and guarantees

| Finding | Change | Evidence |
| --- | --- | --- |
| Native reset overrides primitives | Reset only unslotted buttons, with zero specificity | Browser: select border survives; shared switch state remains intact |
| Status scope | Resolve `--tone-line` on each element/pseudo-element | Browser: warning, error, live badge and boxed alert borders match local tones |
| Overlay fields | Keep primitive border/state styles; customize overlay fill only | Browser: normal/invalid drawer fields and prompt border/focus |
| Toast style | Shared shadow ring, easing, and duration roles | Browser: no visible blur, shared durations, reduced-motion override |
| Touch switch | Preserve track dimensions and separate target area | Browser: 36×20px track, target at least 44×44px, both pointer types |
| Disabled opacity | Shared opacity token; preserve filled-button exceptions | Browser: disabled outline button and input match token |
| Size API | `sm` is 40px; migrate existing 32px consumers to `dense`/`icon-dense` | Browser: small button/select height parity; source tests retain size ladder |
| Documentation drift | Current compact geometry, flat elevation, typography, responsive tiers, and component contracts documented | Reviewed against executable tokens; source tests and CSS lint |

Browser verification also exposed prompt focus being moved during a ref
callback. Text selection now happens on focus, after Dialog captures the
opener. The browser test verifies selected default text, keyboard focus,
Escape dismissal, and return to the opener. Dialog still owns focus restore;
there is no new manual focus trap or restore implementation.

## RED / GREEN evidence

- RED checkpoint: `b6e6467f` (`test: reproduce frontend consistency failures in Chromium`).
  The first browser run produced 24 failures and 4 passes, including genuine
  cascade, status-scope, opacity, size, motion, and touch-geometry failures.
- Corrected test instrumentation after the first run: input elements cannot
  contain rendered style probes, so expected values are resolved in a sibling
  probe carrying the consumer's custom properties. Alert lookup excludes the
  framework announcement region. Shadow comparison ignores Tailwind's
  transparent, zero-size ring placeholders, but still rejects visible blur.
- Revalidated RED for the corrected drawer assertion against the original
  drawer stylesheet: **2 failed**, light and dark desktop. The expected
  boundaries were `rgb(85, 97, 112)` / `rgb(164, 173, 182)`; the originals
  produced structural hairlines `rgb(206, 208, 212)` / `rgb(44, 58, 67)`.
  Restored the fixed stylesheet immediately afterward.
- The additional prompt test failed focus restoration in all four
  theme/pointer combinations before moving selection out of the ref callback.
- GREEN: **32 browser tests passed** in Chromium across light/dark and
  desktop/touch. The final implementation passes the same regression checks,
  including prompt text selection and focus return.

## Commands and results

- `npm run test:design -w web`: 32 passed. Starts its own development server
  on port 5017. Install Chromium once with `npx playwright install chromium`.
- `npm run test:ts`: production builds and typechecks passed; **1,359 tests
  passed**, zero failed or skipped. Includes terminal rendering, command
  compatibility, daemon, supervisor, chat, and web suites.
- `npm run test:py`: **1,123 tests passed**, four existing deprecation warnings.
- `npm run lint:css -w web`: passed.
- `git diff --check`: passed.
- The initial combined `npm test` stopped on two source assertions that pinned
  the previous reset selector and literal opacity. Updated them to the new
  contracts and reran the complete TypeScript suite; Python was run separately.
- `npm audit --registry=https://registry.npmjs.org --json`: reports **9 existing
  dependency advisories** (3 moderate, 6 high), also present before adding the
  browser test dependency. No blanket dependency upgrade was applied. The
  configured mirror does not implement npm audit, so the public registry was
  used for this read-only check without changing registry configuration.

## Scope and limits

The development-only `/dev/design-system` page composes actual components and
returns not-found in production. It does not call APIs or seed server data.
Screenshots from browser tests were inspected for light desktop and dark touch.
These tests verify effective styles and a focused interaction contract, not
all authenticated route workflows or every browser engine.

CSS does not have meaningful statement/branch coverage in this setup; no
numeric 80% coverage claim is made. The guarantees above are covered by
computed-style assertions plus existing source/asset tests. Browser traces
and specimen screenshots are generated under ignored `web/test-results/`.

The RED/GREEN evidence is preserved here if local checkpoint commits are
later squashed. No push, publish, or remote mutation was performed.
