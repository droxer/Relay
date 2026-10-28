# Frontend UX review — 2026-10-28

This review covers frontend recovery, setup, accessibility, and responsive
behavior. The fixes preserve the existing visual system.

## Findings addressed

| Finding | Impact | Change |
| --- | --- | --- |
| Broken profile images had no recovery | Missing or failed image requests replaced agent/team identity with a broken-image glyph | Render the existing identity fallback; allow a different image URL to load |
| Image changes could overlap | Upload, remove, and preset requests could finish out of order | Serialize changes immediately and disable the picker until the request settles; report busy state |
| Rejected file selections were retained | Selecting the same file again could fail to fire a change event | Clear the file input before validation, including rejected files |
| Invisible file input was a second keyboard stop | Keyboard users could focus a clipped control instead of the visible image action | Keep the visible picker as the keyboard entry point |
| Failed inbox requests had no immediate recovery | People had to refresh the whole app or wait for polling | Add an inline retry action, loading feedback, and an announced error |
| Inbox refresh failures were hidden when cached notices existed | Old notices looked current | Preserve the notices and show a retryable refresh error above them |
| Notification preference failures required a reload | Settings became a dead end after a transient request failure | Add inline retry without discarding the current page |
| Computer-list errors looked like an empty inventory | Agent/team setup incorrectly implied the person needed another computer | Distinguish errors from empty results and offer retry in both forms |
| Setup told people to connect a computer without a destination | First-time users reached a disabled selector with no onward action | Link to Computers and disable creation while no computer can be selected |
| Theme radio group had no accessible name | Assistive technology lacked the group's purpose | Name the group “Theme” using the existing translation |
| Phone toasts occupied bottom navigation | Mutation feedback could block navigation controls | Position toasts above the tab bar, retaining the edge placement in conversations and dialogs |

Notification header actions also wrap when their combined width exceeds the
panel. All new recovery copy is present in English and Simplified Chinese.

## Review coverage

Rendered checks used Chromium with mocked local API responses. Public pages
(landing, login, password reset request, waitlist), threads, tasks, automations,
projects, agents, teams, computers, skills, personal settings, and admin users,
computers, and settings were checked at 320px and 1440px. Earlier inspection
also covered 390px phone layouts and the task, agent, team, skill, and computer
creation dialogs. Main surfaces had no document-level horizontal overflow in
the checked empty states.

Targeted checks in both light and dark themes verified notification error →
retry → loaded notices, visible setup recovery, the disabled create action,
the theme group's accessible name, and toast clearance above phone navigation.
The existing browser suites additionally exercised populated threads, files,
board cards, splitters, default-agent onboarding, and unsaved-draft recovery.

This is not a WCAG conformance certification. Real backend operations, physical
touch gestures, Safari/Firefox, and every populated admin state were not
exercised. The Impeccable context/detector engine was unavailable; the review
used source, rendered pages, and the repository's tests.

## Verification

- React interaction suite: 671 tests passed; focused regression tests were
  rerun after the final edits (including an additional image-error retry case).
- Existing browser suites: `surfaceLayout.spec.ts`, `frontendRecovery.spec.ts`,
  and `defaultAgentsPrompt.spec.ts` — 19 passed.
- TypeScript package/test compilation: passed (`npx tsc -p packages/tsconfig.json`).
- Frontend Node tests: 1,924 passed; one existing favicon expectation failed.
  `brandIdentity.test.ts` expects a light color-scheme variant, while the
  unchanged SVG documents an intentional fixed-black tile. No brand change was
  made to satisfy that conflicting expectation.
- ESLint and Stylelint: passed.
- Production build: `next build --webpack` passed, including TypeScript and
  static export. The default Turbopack build failed while binding an internal
  subprocess port (`Operation not permitted`), including on retry outside the
  sandbox.
- `git diff --check`: passed.

No backend, API, database, or daemon behavior changed. No external resources
were modified.
