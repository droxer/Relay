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

## Follow-up review — findings

This pass reviews the current source and the committed populated Tasks and
Threads screenshots. It does not repeat the resolved findings above. Findings
below are implementation observations and design recommendations, not newly
executed browser reproductions. Frontend dependencies and a built export were
absent in this checkout. The Impeccable context loader and detector were
attempted but could not run because their engine was not installed and the
default cache directory was not writable. No application code was changed.

### P1 — New thread silently clears an unsent message

- Evidence: `web/src/hooks/useThreadNavigation.ts:104–118` calls the composer's
  `clear()` when starting a new standalone thread. `useComposer.ts` holds text
  only in component state; neither it nor `Composer.tsx` registers an unsaved
  changes guard or persists the draft.
- Impact: someone composing a detailed request can lose it by pressing the
  new-thread plus. A reload also has no draft restoration through this path.
- Recommendation: keep drafts by thread, with a distinct new-thread draft.
  Restore them on return and refresh. As an immediate safeguard, ask before
  clearing nonempty text, using the existing unsaved-changes dialog.
- Validate: type an unsent request, start a new thread, return, and reload;
  confirm that the draft survives or that cancellation preserves it.

### P1 — Archive/unarchive can discard unsaved project edits

- Evidence: `ProjectSettingsPanel.tsx:124–145` permits archiving while dirty,
  retains the dirty draft on archive, then unconditionally adopts the server
  record on unarchive. The archived fieldset and Save button are disabled
  (`:188`, `:265`). The archive confirmation describes execution restrictions,
  without mentioning pending edits.
- Impact: archiving strands an unsaved name, goal, description, or context;
  choosing Unarchive to resume editing replaces that draft without warning.
- Recommendation: resolve pending changes before archiving with Save and
  archive, Discard and archive, and Cancel. Keep the draft intact if saving or
  archiving fails. Do not overwrite an existing draft on unarchive.
- Validate: edit several fields, archive, then unarchive; check cancellation,
  request failure, and preservation of all edited values.

### P2 — File-preview failures have no direct recovery

- Evidence: `workspace/WorkspaceFilePreview.tsx:69–71` renders the raw error
  message as a paragraph, with no retry control or alert role.
  `ProjectWorkspaceFiles.tsx:83–90` passes a retry for the directory query only;
  `WorkspaceFilePanes.tsx` has no preview retry callback.
- Impact: after a failed file read, the reader must discover an indirect
  refetch path. Retrying the directory does not retry the selected content.
- Recommendation: add a localized, announced preview error with Retry wired
  to the content query. Preserve the selected path and distinguish a missing
  file from a temporarily unreachable computer.
- Validate: make the file-list request succeed and the file-content request
  fail, then recover the content using Retry without reopening the file.

### P2 — Phone task rows hide status words

- Evidence: `styles/backlog-list.css:715–721`, inside the 820px breakpoint,
  visually hides the status label from the labeled `InlineStatus` control.
  Its native `title` remains the sighted explanation. The icon and accessible
  name survive; this is a touch discoverability issue, not a missing accessible
  name.
- Impact: phone users must learn the difference between ready, running,
  review, and waiting glyphs or open a control/record to identify the state.
  Grouping by project or assignee supplies no status heading to compensate.
- Recommendation: retain a short status word in the metadata line whenever
  the group does not already name the status. Preserve the icon as a scan aid.
- Validate: populated Tasks at 375px, grouped by project and assignee, including
  running, review, waiting, and blocked records; check text enlargement too.

### P2 — Long blocker reasons depend on hover

- Evidence: `task-board/TaskHoldupLine.tsx:34–37` places the complete reason in
  a native `title` on a nonfocusable span. `styles/task-status.css:457–461`
  truncates the visible reason to one line. The populated Tasks screenshot
  also shows a clipped blocker reason.
- Impact: a touch user or sighted keyboard user must open the record to read
  the complete explanation needed to unblock the task.
- Recommendation: allow blocker reasons to wrap on phones, or provide an
  explicit expandable explanation. Keep long reasons visually secondary to
  the task title while making their full content reachable without hover.
- Validate: long reasons on phone and desktop, keyboard-only expansion, and
  expanded text at increased font size without covering neighboring controls.

### Additional design suggestions

- Priority vocabulary: `task-board/InlineTaskFields.tsx:119–133` shows only
  priority bars and a native title. Use a short visible priority label on
  phone rows, or add a discoverable explanation. Accessible names already
  exist, so this recommendation concerns sighted comprehension.
- Create-action discovery: populated list headers consistently use a bare
  plus (`TaskBoardHeaderActions.tsx`, `ThreadListPanel.tsx`). Keep the shared
  visual pattern, but test a labeled create action for new users before
  collapsing it to an icon in constrained layouts. This is a usability
  hypothesis, not a demonstrated task-completion failure.

Prioritize draft preservation and the archive flow, then preview recovery,
then information visibility on phones. Preserve the existing grouped task
queues, shared controls, and separation of work from configuration; those
provide a coherent foundation. The initial follow-up was documentation-only;
the implementation and subsequent checks are recorded below.

## Follow-up implementation

All five findings and both additional design suggestions have been addressed:

| Finding | Resolution |
| --- | --- |
| Unsent thread messages | Keep a separate draft for each user/thread and for new threads in session storage; restore on navigation and refresh; clear storage when the draft is cleared or submitted |
| Archive with pending edits | Disable Archive while edits are pending, explain how to proceed, and preserve a dirty draft on Unarchive if another client archived the project |
| Preview recovery | Announce localized file-read errors and offer Retry for the selected file on project, task, and thread file surfaces; retry content independently of the directory |
| Phone status recognition | Retain the status word in the task metadata line instead of hiding it |
| Truncated blockers | Open the full blocker, question, or prerequisite explanation in a keyboard/touch-accessible popover; Escape restores focus |
| Priority recognition | Show priority words beside their glyphs on phones |
| Create-action discovery | Label the shared create actions on desktop across tasks, automations, threads, projects, agents, teams, computers, skills, and channels; retain named compact icons in phone headers |

Drafts are scoped to a browser tab and user. They survive refresh but are not
synced between devices. When browser storage is blocked or full, editing still
works, but persistent draft restoration is unavailable.

Regression tests cover independent drafts, account isolation, clearing,
storage failures, new-thread navigation, dirty archive prevention, external
archiving followed by unarchiving, preview error messages, selected-file retry,
and blocker disclosure. The original behavior failures were reproduced by
tests before their fixes.

Validation after implementation:

- React interaction suite: 683 passed across 118 test files.
- TypeScript compilation for the frontend and package/tests passed.
- ESLint and Stylelint passed.
- Production static export passed with `next build --webpack`.
- Existing recovery and surface-layout browser suites: 15 passed.
- Direct Chromium checks with mocked local API responses verified new-thread
  navigation, per-thread draft restoration after refresh, blocker popover
  interaction, Escape, and focus restoration. Both mouse and touch emulation
  were exercised.
- Populated task layouts were visually checked in English/light and
  Chinese/dark, including 320px, 375px, 820px, and 1440px widths. The checked
  layouts had no document-level horizontal overflow.
- Frontend Node suite: 1,924 passed; the previously documented unchanged
  favicon color-scheme expectation remains the sole failing test. The create
  action source contract was updated to accept the additional label class.

These checks use mocked APIs and Chromium emulation; physical touch devices
and other browser engines were not exercised. No backend, API, database, or
daemon code changed.
