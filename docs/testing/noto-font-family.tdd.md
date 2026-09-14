# Noto multilingual font family — TDD evidence

## Source

The journeys were derived from the approved recommendation to adopt Google
Fonts' Noto Sans family for English, Simplified Chinese, and Traditional
Chinese while retaining JetBrains Mono for technical text.

## User journeys

- As an English-language Relay operator, I want Noto Sans to carry every UI
  and display role so the product has one dependable open-licensed sans.
- As a Chinese-language operator, I want the matching SC or TC Noto family to
  carry both Latin and Han glyphs without eagerly downloading the other
  region's family.
- As an operator in a restricted or offline runtime environment, I want font
  files served by Relay itself rather than fetched from Google in the browser.

## Task report

- Replaced the vendored IBM Plex Sans application face with `Noto_Sans`,
  `Noto_Sans_SC`, and `Noto_Sans_TC` from `next/font/google`.
- Kept SC and TC preloading disabled; the pre-paint `lang` attribute selects
  the correct region while native CJK families remain fallbacks.
- Removed the unused Plex binary and license, retained the local JetBrains Mono
  assets, and updated the typography documentation.

## Test specification

| # | What is guaranteed | Test file or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Noto Sans and both regional families are configured through `next/font/google` and no browser Google URL is embedded | `web/tests/typographyTokens.test.ts` | Unit contract | PASS | Focused run: 17/17 tests passed |
| 2 | SC and TC expose separate CSS variables and neither regional family is preloaded eagerly | `web/tests/typographyTokens.test.ts` | Unit contract | PASS | Focused run: 17/17 tests passed |
| 3 | The old Plex binary and license are removed while JetBrains Mono remains materialized and licensed | `web/tests/typographyTokens.test.ts` | Asset contract | PASS | Focused run: 17/17 tests passed |
| 4 | Next.js can resolve, self-host, compile, typecheck, and prerender the selected Google fonts | `npm run build -w web` | Build integration | PASS | Next.js 16.3.5 production build completed |
| 5 | The complete TypeScript and React suites remain green with the new global font configuration | `npm run test:ts` | Regression | PASS | 1,471 Node tests and 56 React tests passed |

## RED / GREEN evidence

- RED checkpoint `1348b8b2`: the focused suite failed four assertions because
  Plex still shipped and neither the Noto loaders nor region-first stacks
  existed.
- GREEN checkpoint `ab759eb7`: the same focused suite passed 17/17 tests, and
  the production build completed successfully.

## Coverage and known gaps

The changed font configuration, token stacks, preload policy, and asset removal
are covered directly by source and asset contracts. The production build is
the integration check for Next's build-time Google download and self-hosting.
Repository-wide TypeScript verification passed with 1,527 tests total.
The generated media directory contains the complete region-subset catalog, but
the CJK fonts are not preloaded and Unicode-range selection limits browser
downloads to glyph shards used by the active language and page content.
