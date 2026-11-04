# Mobile design review — 2026-11-04

## Scope and method

Reviewed Relay's public pages and exposed application routes in local Chromium,
using browser-side API fixtures rather than changing server data. Preserved the
existing visual system. Inspected empty and populated pages, long names, disabled
controls, creation drawers, and selected translated/dark states.

Primary review sizes were 320 × 740 and 375 × 812. Targeted checks also covered
390 × 844, 820 × 390 landscape, and 1440 × 900 desktop. These are browser
emulations, not physical-device or Safari results.

## Changes

| Surface | Problem | Result |
| --- | --- | --- |
| Shared navigation | Six bottom tabs crowded phone navigation | Five tabs; Agents remains available through More, whose active state follows it |
| Shared phone header | Long record titles could occupy four lines beside actions | Titles stop at two lines; full text remains in the DOM |
| Home | Queue filters wrapped into two rows at 320px | One compact strip, scrollable for longer translated labels |
| Tasks | Long project group headings painted beyond the clipped table | Names wrap; counts retain their own space |
| New thread in landscape | Centred content clipped the greeting above the viewport | Compact heading and a scrollable layout keep the draft and computer context in flow |
| Composer | The unavailable-agent explanation was truncated | The complete reason remains readable and can wrap |
| Skills detail | The owner's form grid expanded beyond a 320px pane | Shrinkable grid track, bounded visibility control, mobile gutters and stacked actions |
| Task and automation details | The tabs reserved a whole extra row for the overflow menu | Tabs and menu share one row, with scrollable tabs when needed |
| Record properties | Long project and assignee values were cut off | Narrow record panels wrap values into readable rows |
| Admin | Invitation actions could exceed a narrow header | Actions wrap inside the available width, including longer labels |

## Page-by-page coverage

| Pages | Rendered states reviewed |
| --- | --- |
| Landing, sign-in | Narrow layout, navigation, form field sizes and no document overflow |
| Request access, join, forgot password, reset password | Disabled access/reset service and invalid-link states |
| Home | Empty and populated summaries, setup progress, notification inbox, dark Chinese labels |
| Threads and new thread | Empty directory, populated conversation, code block, composer with no runnable agent |
| Projects | Directory, dashboard, Tasks, Automations, Files, Settings, project agents, project setup drawer |
| Tasks | Empty and populated list, long project grouping, record properties and activity, creation drawer |
| Automations | Empty and populated list, routine record, definition, empty runs, creation drawer |
| Agents | Empty and populated roster, long-name profile, Skills tab, creation drawer |
| Teams | Empty and populated roster, member/profile view, creation drawer |
| Computers | Empty and populated cards, connection drawer |
| Skills | Empty and populated library, detail, owner management form, publication drawer |
| Settings | Account, Notifications, Appearance, Language |
| Admin | Dashboard, Users, Waitlist, Computers, Organization |
| More | Dark translated sheet, navigation to Agents, active state, five visible tabs |

Channels is disabled in the current product and is not an exposed navigation
surface. Existing browser tests additionally exercise review, recovery, filters,
project/task editing, computer approval, and team handoff flows.

## Verification

- `npm run build -w web`: passed, including production TypeScript checking.
- `npx tsc -p packages/tsconfig.json`: passed.
- `npm run lint:css -w web`: passed.
- `cd web && npx eslint src/components/SideNav.tsx`: passed.
- `node --test dist/web/tests/sidenav.test.js dist/web/tests/designIssues.test.js`:
  35 passed.
- Full recovery browser suite: 114 passed, 5 failed. Rebuilt the unchanged
  baseline and reran the affected files: the same five failures reproduced.
  Those baseline failures are the agent availability-filter test, three GitHub
  connection variants, and the team responsibility payload assertion.
- Final recovery suite with only those five baseline failures excluded:
  114 passed. Command:

  ```sh
  cd web
  npx playwright test -c playwright.recovery.config.ts --workers=2 \
    --grep-invert 'the agent roster rail filters availability with a chip|Public GitHub imports and coming-soon connection|team responsibilities can be edited and persist after reload'
  ```

- Targeted browser assertions verified Skills controls fit at widths 320, 375,
  390, 820, and 1440; More navigates to Agents and exactly five tabs show on
  phone layouts.
- The populated 320px route sweep found no document-level horizontal overflow
  or out-of-viewport form/button controls. Deliberately scrollable tab strips
  and code snippets are checked separately from document overflow.
- Impeccable mechanical checks returned no findings on the changed UI targets.
- `git diff --check`: passed.

Screenshots, fixture scripts, build logs, baseline evidence, and browser results
are retained locally in `/tmp/relay-mobile-review-2026-11-04/`.

## Limits

Physical phones, the shipping mobile Safari app, native keyboard/browser chrome,
and real network latency were not tested. WebKit engine emulation is covered by
the follow-up below; it does not replace physical-device testing. The five
baseline test mismatches remain outside the production UI changes.


## Follow-up: interaction and Safari-engine checks

A second pass checked 31 loaded application views in both Chromium and WebKit at
320px, including detail tabs, and all six public routes in WebKit at 320 × 568.
The public checks include enabled access/reset forms and valid invite/reset
fixtures. Every application check waits for the shell to mount; a loading gate
is not counted as a verified page. No document overflow or unintentionally
clipped interactive controls was found in those sweeps.

Additional fixes:

- Avatar presets were about 30px wide in the narrow popover. A container query
  now uses four columns where touch targets would otherwise be too small, with
  a 44px minimum on both axes. Wider layouts retain their existing grid.
- A populated notification inbox extended below a short viewport. Its list now
  shrinks and scrolls within the positioner's available height, while header
  actions and the settings footer stay reachable. The mobile settings link also
  has a full-height touch target.
- Mobile search now has an explicit close control beside the input, so dismissal
  is available without Escape or finding a small area of backdrop.
- Home was missing from the service worker's navigation allowlist. Offline Home
  now receives the same generic offline/retry page as the other application
  routes. This does not cache authenticated application data.

The mocked recovery browser suite now blocks service workers. In WebKit a
controlling worker bypassed the page's API interception, causing fixture-based
reloads to receive the static server's HTML instead of API JSON. This is a test
configuration fix; the separate PWA suite continues to exercise real workers.

Follow-up validation:

- Chromium and WebKit: 31 loaded application views each, no document overflow.
- WebKit: six public routes; visible form fields stay within 320px, use at least
  16px text, and reach the 44px touch height.
- Chromium and WebKit: synthesized taps open, filter, and close search; avatar
  targets and notification scrolling/settings navigation pass at 320 × 568,
  390 × 844, and 820 × 390.
- Real service worker: offline recovery checked on 11 main/deep routes,
  including Home, Threads, Tasks, Automations, Projects, Agents, Teams,
  Computers, Skills, Settings, and Admin.
- `npx playwright test -c playwright.pwa.config.ts --workers=2`: 6 passed.
- Recovery browser suite without exclusions: 114 passed, the same 5 baseline
  mismatches failed. The GitHub assertions still expect a region named “GitHub
  connection” rather than the current “Connections” section; the agent test
  expects the retired availability chip; the team assertion omits the role now
  included in the responsibility payload. These were not hidden by exclusions
  or changed to make the suite green.
- Focused React interaction tests: 18 passed. Notification/profile/avatar Node
  checks: 29 passed.
- Production web build, TypeScript compilation, owning component lint, CSS lint,
  mechanical design scan, and `git diff --check`: passed.

Follow-up screenshots, fixtures, and logs are retained locally in
`/tmp/relay-mobile-followup-2026-11-04/`.


## PR verification

The broader web checks run while preparing the PR found and fixed an
unregistered avatar container breakpoint. The picker now shares the existing
420px container tier with GitHub-import forms, and the palette registry
explicitly documents both consumers.

- All web Node tests: **2,008 passed, 2 failed**. The two source-assertion failures
  concern recovery operation IDs and persisted backlog-view hydration. Both
  reproduce against an archived copy of the unchanged `HEAD` source.
- Complete React interaction suite: **775 passed across 132 files**.
- Production dependency audit against the official npm registry: **0
  vulnerabilities**. The configured mirror does not implement the audit API;
  the registry override was command-local and changed no npm configuration.
- Production build, CSS lint, and whitespace checks passed after the registry
  correction.

Selected fixture screenshots are committed for review:

| Surface | Before | After |
| --- | --- | --- |
| Skills form, 320px | [Before](../images/mobile-review/skills-before.png) | [After](../images/mobile-review/skills-after.png) |
| Notification inbox, 320 × 390 | [Before](../images/mobile-review/inbox-before.png) | [After](../images/mobile-review/inbox-after.png) |
