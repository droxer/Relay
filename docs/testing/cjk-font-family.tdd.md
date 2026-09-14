# CJK font-family fixes — TDD evidence

## Source

The journeys were derived from the review findings for the current frontend
font-family implementation.

## User journeys

- As a Relay operator on Linux, I want Simplified and Traditional Chinese UI
  text to select the installed regional Noto CJK family explicitly, so mixed
  Latin and Han labels do not fall through to an unrelated generic face.
- As a returning Chinese-language user, I want the document language applied
  before first paint, so hydration does not switch the entire UI to a
  different font family and set of metrics.

## Task report

- Added locale-contract assertions for the exact `Noto Sans CJK SC/TC` and
  `Noto Sans Mono CJK SC/TC` family names. The RED run failed on the missing
  Simplified Chinese sans family.
- Added a bootstrap contract requiring the saved, supported language to be
  applied to the root element. The RED run failed because the head script did
  not read `relay-web.language`.
- Added the regional Linux font names to both Chinese locale stacks and applied
  an allowlisted saved language alongside the theme in the existing pre-paint
  script.

## Test specification

| # | What is guaranteed | Test file or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Both Chinese locales explicitly name their regional Noto CJK sans and mono families | `web/tests/typographyTokens.test.ts` | Unit contract | PASS | Focused run: 17/17 tests passed |
| 2 | The pre-paint bootstrap reads the saved language, accepts both Chinese locales, and applies it to `<html>` | `web/tests/typographyTokens.test.ts` | Unit contract | PASS | Focused run: 17/17 tests passed |
| 3 | The production frontend compiles and prerenders with the bootstrap script | `npm run test:ts` | Build/integration | PASS | Next.js production build completed; 1,471 Node tests and 56 React tests passed |
| 4 | The changed CSS passes the design-token style rules | Pre-commit `stylelint` hook | Static analysis | PASS | GREEN checkpoint hooks passed |

## RED / GREEN evidence

- RED checkpoint `78106b71`: the focused suite ran 12 tests and failed the two
  new regressions for missing regional Noto family names and missing pre-paint
  language application.
- GREEN checkpoint `dfeec88d`: the same focused area ran 17 tests with no
  failures after the font-stack and bootstrap changes.

## Coverage and known gaps

The changed CSS values and inline bootstrap behavior are covered directly by
source contracts. Repository-wide TypeScript verification passed with 1,527
tests total (1,471 compiled Node tests and 56 React tests). A pixel-level visual
comparison across macOS, Windows, and Linux is outside automated coverage; the
contract instead protects the platform-specific family names and selection
trigger that caused the regressions.
