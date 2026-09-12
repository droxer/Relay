# Compact typography scale — TDD evidence

## Source

The journey was derived from the request to review the application-wide font
sizes and reduce the oversized feel without making small utility text illegible.

## User journey

As a Relay operator, I want a quieter, more compact type scale across every
route, so that the multi-pane interface is easier to scan without losing clear
hierarchy or browser-controlled text scaling.

## Task report

- Added a token-level contract for the complete default type ladder and hero
  clamp. Before the token change, the focused test failed because `--fs-3`
  resolved to 15px instead of the expected 14px.
- Updated the shared typography tokens, semantic-role documentation, markdown
  annotations, and the design-system reference. The same focused test and the
  full typography contract then passed.
- Kept the 87.5% rem root and 12px minimum utility rung intact, so browser font
  preferences continue to scale the interface and captions do not shrink.

## Test specification

| # | What is guaranteed | Test file or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | The default ladder resolves to 12/13/14/15/17/19/22/28px and the hero clamps to 22–36px | `web/tests/typographyTokens.test.ts` | Unit contract | PASS | `node --test dist/web/tests/typographyTokens.test.js` — 11/11 tests passed |
| 2 | The typography CSS follows repository style rules | `web/src/styles/**/*.css` | Static analysis | PASS | `npm run lint:css -w web` |
| 3 | The edited diff has no whitespace errors | Changed files | Static analysis | PASS | `git diff --check` |

## RED / GREEN evidence

- RED: the focused contract executed and failed with `--fs-3 should resolve to
  14px at the default browser size`.
- GREEN: the full typography contract completed with 11 passing tests and no
  failures.

## Coverage and known gaps

The change is entirely within shared CSS custom properties; the token contract
covers every changed value directly, while existing role tests cover their
consumption. A live visual pass was not available because this session exposed
no controllable browser. The full Next.js build was also blocked in the sandbox
when Turbopack attempted to bind an internal port; direct TypeScript compilation
reached an unrelated pre-existing missing `.js` extension in
`web/src/components/task-board/producedFileRows.ts`.

No checkpoint commits were created because the worktree already contained
unrelated user edits, including files in the same frontend surface. This avoids
capturing or rewriting work that is outside this typography change.
