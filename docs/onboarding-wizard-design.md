# Onboarding Wizard Design

> Note (2026-10-18): the file-backed accounts store this plan mentions has since been retired; accounts and reset links are database-only, and legacy `auth/` file imports have also been removed; migrate those files with an earlier release before upgrading.

Status: built · 2026-10-16 (see *As built* at the end for where it differs from this proposal)

## Problem

A new User signs in to an empty Relay. Every surface answers with its own
empty state ("No threads", "No computers", "No agents"), but nothing says
which one comes first or why. The model behind Relay — work runs on *your*
Computer, through a Logical Agent placed on it, inside a Thread or Task
Workspace — is invisible until each piece exists, and the order is strict:

```text
Computer (daemon connected) ─► Agent Runtime ready ─► Logical Agent placed ─► Thread ─► run
```

Skip a step and the failure surfaces late and indirectly: the composer
accepts a message and dispatch answers `node_offline` or
`executor_not_ready`. The wizard's job is to get a User from sign-in to a
first finished agent run in about five minutes, and to leave them with the
vocabulary in [`CONTEXT.md`](../CONTEXT.md) along the way.

## Goals

1. **Time to first run.** One guided path from sign-in to a completed agent
   turn, using the real flows — not a sandbox or demo data.
2. **Teach the model by doing.** Each concept is introduced the moment it
   becomes real for the User, in one sentence, with the glossary term.
3. **Never block.** The wizard is a guide beside the app, not a gate in front
   of it. Every step can be skipped; the whole thing can be dismissed.
4. **Resumable.** Close the tab mid-install, come back tomorrow, land on the
   same step.

## Non-goals

- A product tour of every surface (tooltips pointing at every nav item).
- Seeded or mocked data — the server never seeds (AGENTS.md invariant).
- Admin fleet setup (managed nodes, users, waitlist). An admin gets the same
  personal path; fleet setup stays in `/admin`.
- Teaching Teams, Projects, and Automations hands-on. They get an "Explore
  next" card each, not a required step.

## Design principles

- **Progress is derived, not stored.** A step is complete because the thing
  exists, read from the queries the app already makes. The only stored state
  is the User's own choices: dismissed, and which optional cards they closed.
  This matches how the repo treats task workspaces and wait projections — one
  seam that derives, no flag that can drift from reality.
- **Reuse the existing flows.** Step 1 *is* `ConnectComputerDrawer` /
  `ComputerDeviceSetup`; step 2 *is* `CreateAgentDialog`; step 3 *is* the
  composer. The wizard frames them; it does not fork them.
- **One concept per step, named once.** Every step opens with a one-line
  definition using the glossary term (Computer, Agent, Thread, Task) and
  never its avoided synonyms (machine, executor, chat).

## The path

Four steps, plus an "Explore next" tail. Each has a *done* predicate computed
by one pure function, `onboardingProgress()` in `web/src/lib/onboarding.ts`.

| # | Step | Teaches | Done when | Reuses |
|---|------|---------|-----------|--------|
| 0 | How Relay works | Backend coordinates, Computers execute | User pressed *Start* (or any later step is done) | — |
| 1 | Connect a Computer | Computer, Daemon Node, workspace root | User has ≥1 Computer and one is online | `ConnectComputerDrawer`, `ComputerDeviceSetup` |
| 2 | Create your first Agent | Logical Agent, Agent Runtime, Placement | User owns ≥1 Agent with an active Placement on an online Computer whose runtime is `ready` | `CreateAgentDialog` |
| 3 | Run your first Thread | Thread, Thread Workspace, generated files | User owns ≥1 Thread with a completed agent run | Composer + `TranscriptEmpty` starters |
| — | Explore next | Task, Project, Team, Automation | Optional; each card dismissible | Links to `/tasks`, `/projects`, `/teams`, `/automations` |

Step 0 is the only step whose completion is a stored choice, because it
produces nothing; once any later step is done, step 0 counts as done too, so
an existing User never sees it.

### Step 0 — How Relay works (≈30 s)

A single panel with a three-node diagram (re-using the `relay-empty-diagram`
geometry) and three sentences:

> **Relay** keeps track of your work. It never runs agents itself.
> **Your Computer** runs them — your laptop, or a machine your admin gave you.
> **Agents** do the work in **Threads** (conversations) and **Tasks** (tracked work).

One button: *Start setup*. A secondary link: *I've used Relay before* —
dismisses the wizard.

### Step 1 — Connect a Computer

Body: "A Computer is where your agents actually run. Relay connects to it
through a small background service (the daemon)."

Inline (not in a drawer — the wizard pane is the drawer's content area):
`ComputerDeviceSetup` with its install command, then a live status row:

```text
┌ Connect a Computer ─────────────────────────────── Step 1 of 3 ┐
│ A Computer is where your agents actually run.                  │
│                                                                │
│ 1  Run this in a terminal                         [Copy]       │
│    curl -fsSL https://…/install.sh | sh                        │
│ 2  Choose the folder agents may work in                        │
│ 3  Approve the device in the browser tab that opens            │
│                                                                │
│ ◌ Waiting for your Computer to connect…        (aria-live)     │
│                                                                │
│ Set up manually instead · Skip for now                         │
└────────────────────────────────────────────────────────────────┘
```

The status row polls the User's computers on the existing interval and flips
to `● MacBook Pro connected — 2 runtimes ready (Claude, Codex)` the moment a
node is online; the step auto-advances after a 1.5 s beat so the User sees
the success.

Branches:

| Situation | What the wizard shows |
|---|---|
| Admin already placed the User on a Computer | Step auto-completes on first load: "You already have a Computer: *build-01*." |
| `max_local_computers` reached or `0` (`decorate_account_limits`) | No install command. "Your organization manages Computers for you — ask an admin to assign one." Step stays open; the rest of the wizard waits on it. |
| Node online, but no runtime `ready` | Stay on step 1 with "Connected, but no agent CLI is ready" + the `RuntimeRefreshButton` and a link to the runtime's install docs. |
| Windows | `ComputerDeviceSetup` already shows the PowerShell command; no extra work. |

### Step 2 — Create your first Agent

Body: "An Agent is a named worker you own. It runs on one runtime (Claude,
Codex, Pi, or Kimi) on one of your Computers — that link is its placement."

Opens `CreateAgentDialog` pre-filled: the Computer from step 1, the first
`ready` runtime (Claude preferred if ready), and a suggested name. The User
can change anything. Only `ready` runtimes are offered as the default, so the
first dispatch cannot fail with `executor_not_ready`.

Done when `onboardingProgress` sees an Agent with an active Placement on an
online Computer whose runtime reports `ready` (`agentReadiness`).

### Step 3 — Run your first Thread

Body: "A Thread is a conversation with your agents. Everything they write
lands in the Thread's workspace on your Computer."

The wizard opens a new Thread on the step-1 Computer with the step-2 Agent
selected in the composer and offers one **starter prompt** chosen to show the
whole loop, including a generated file:

> Look around this folder and write `RELAY-TOUR.md` summarizing what's here
> in five bullets.

The User may send it, edit it, or write their own. While the run streams,
a slim callout under the transcript points at the two things worth noticing:
the live output, and the file chip that appears when `generatedFiles` lands.
Done on the first `run.completed` in a Thread the User owns.

Failure path: if dispatch fails, the existing `formatDispatchError` text is
shown inside the step with a *Back to step 1/2* link chosen by its code
(`node_offline` → 1, `executor_not_ready` / `agent_configuration_pending` → 2).

### Finish — Explore next

A short celebration line ("Your first run is done.") and four cards. Each
links to its page and closes independently:

| Card | One-liner |
|---|---|
| Tasks | "Turn work you'll come back to into a Task with its own workspace and status." |
| Projects | "Give several agents one shared workspace and a brief." |
| Teams | "Put a lead and members on one Computer and let them split the work." |
| Automations | "Run a Task on a schedule or when something happens." |

When all cards are closed, or the User presses *Done*, the wizard is
dismissed.

## Surfaces

The wizard is not a modal. It appears in three places, all driven by the same
`onboardingProgress` result:

1. **Home panel** (primary). On the Threads home, when the User has no Thread
   selected and the wizard is not dismissed, the wizard pane replaces
   `TranscriptEmpty`. This is where every new User lands, and it is the
   empty space that today says least.
2. **Sidebar checklist chip**. A compact `Get started · 1/3` row at the foot
   of the navigation rail while the wizard is active, so a User who wandered
   to `/agents` can get back. Clicking it returns to the home panel at the
   current step.
3. **Command menu**. A `Get started` command (`lib/commandMenu.ts`) that
   re-opens the wizard even after dismissal — the only way back, so it must
   exist.

Empty states on Computers, Agents, and Threads pages keep their own CTAs; they
gain one line of copy naming the prerequisite ("Agents need a Computer to run
on — connect one first") when that prerequisite is missing, with a link that
opens the wizard at the right step.

## State and persistence

```ts
// web/src/lib/onboarding.ts — pure, unit-tested
type OnboardingStep = "intro" | "computer" | "agent" | "thread" | "explore";

type OnboardingInputs = {
  computers: readonly ComputerSummary[];   // user's own + assigned
  agents: readonly AgentSummary[];         // with placements
  threads: readonly ThreadSummary[];       // owned, with run status
  computerLimit: { canEnroll: boolean };   // decorate_account_limits
  prefs: OnboardingPrefs;
};

type OnboardingProgress = {
  current: OnboardingStep;                 // first incomplete step
  done: Record<OnboardingStep, boolean>;
  blockedReason?: "computer_limit" | "no_ready_runtime";
  visible: boolean;                        // !prefs.dismissedAt
};

export function onboardingProgress(input: OnboardingInputs): OnboardingProgress;
```

`OnboardingPrefs` is the only persisted state:

```ts
type OnboardingPrefs = {
  introSeenAt?: string;
  dismissedAt?: string;
  closedCards?: readonly ("tasks" | "projects" | "teams" | "automations")[];
};
```

**Where it lives.** On the Account, next to `theme` and `language`:
`PATCH /api/v1/auth/preferences` gains an optional `onboarding` object,
validated in `_validate_user_preferences`, returned on `/auth/me`. Both auth
stores need the field (file store: a JSON key; database store: one nullable
JSON column on `auth_accounts` via a new Alembic migration). Server-side
storage is the point — a User who installs the daemon from their laptop and
opens Relay on their desktop should not see step 0 again.

**Existing Users.** No backfill of progress. Anyone who already has a
Computer, Agent, and completed Thread derives `done` on every step; the
migration also sets `dismissedAt` for every account that existed before it,
so nobody is greeted by a wizard they don't need.

## Accessibility

- The wizard pane is a `<section aria-labelledby>` with an `<ol>` of steps;
  the current step has `aria-current="step"`.
- Status changes (computer connected, run finished) announce through one
  polite `aria-live` region; auto-advance moves focus to the next step's
  heading, never into the middle of a form.
- Every action is a real button; the install command uses the existing
  `CredCopyRow`, which is already keyboard and screen-reader complete.
- Respect `prefers-reduced-motion` for the step transition and success beat.

## Implementation notes

- **Bundle boundary.** The wizard lives in the signed-in app chunk and is
  `lazy`-loaded from the Threads home, like `ProjectWorkspacePage` — it must
  not leak into the landing entry (see the entry-split note in AGENTS.md).
- **No new polling.** Step 1 reuses the computers query; step 3 reuses the
  session SSE stream already open for the Thread.
- **Styling.** Use existing tokens and `RelayEmptyState` geometry; no new
  colors outside `palette.css`. The step list follows the section-rail
  grammar (active = `--action-soft`).
- **i18n.** All copy under `onboarding.*` in `en` and `zh-CN`.
- **Files.**
  - `web/src/lib/onboarding.ts` — `onboardingProgress`, starter prompt keys.
  - `web/src/components/onboarding/OnboardingPanel.tsx` — the pane and step list.
  - `web/src/components/onboarding/steps/*.tsx` — one component per step,
    each wrapping the existing flow.
  - `web/src/components/onboarding/OnboardingChip.tsx` — the rail chip.
  - `backend/relay/security/onboarding.py`, `security/auth_accounts.py`
    (`update_user_preferences`) + migration — `onboarding` preference.

## Testing

- `web/tests/onboarding.test.ts` — `onboardingProgress` across the matrix:
  no computer / offline computer / online but no ready runtime / limit
  reached / admin-assigned computer / agent without placement / thread
  without completed run / dismissed / existing fully-set-up User.
- Component tests for each step's branch copy and the dispatch-error
  back-links.
- Backend: preference validation (unknown keys rejected, card ids
  allowlisted), round-trip through both auth stores, migration sets
  `dismissedAt` for existing accounts.
- e2e on the live harness (stub daemon): sign in as a fresh User, follow the
  wizard through a completed run, reload mid-step to prove resume.

## Measuring it

Success is the share of new accounts that reach a completed run within their
first session, and the median time to get there. Both are derivable from
existing data (account `createdAt`, first `daemon_nodes` row, first
`agent.started`, first `run.completed`) — no client analytics is required.
Track where Users stall by the step `onboardingProgress` reports for accounts
that never finished.

## Open questions

1. Should step 3's starter prompt write a file (shows generated files, but
   touches the User's folder) or stay read-only ("summarize this folder")?
   Proposal: write `RELAY-TOUR.md`, and say so in the prompt text.
2. For Users whose admin enrolls their Computer, should the wizard notify the
   admin from step 1 ("Request a Computer"), or just tell the User to ask?
   Proposal: just tell them in v1; a request flow is its own feature.
3. Should a second Computer or Team setup ever re-open the wizard? Proposal:
   no — once dismissed, only the command menu brings it back.

## As built

Implemented on 2026-10-16. Where it departs from the proposal above:

- **Step 0 completes only by choice.** The intro counts as done only once the
  person presses *Start* (`introSeenAt`), so a User whose admin already
  assigned a Computer still gets the two-sentence model. An account that
  finished every setup step without ever seeing the intro is treated as
  pre-wizard and never shown it — that covers the file auth store, which has
  no migration.
- **Explicit reopening records the intro choice.** The command menu clears
  dismissal and closed cards and marks the intro read. This overrides the
  pre-wizard suppression for fully configured file-store accounts.
- **The starter carries its target.** Progress selects an available Agent and
  the online Computer hosting its active Placement with a ready runtime. The
  starter selects that Computer and Agent in the composer before adding text.
  A manually completed Thread counts only if one of its Agent runs completed.
- **Preference writes are serialized.** The browser retains all pending choices
  while saving in order. The backend locks before reading and merging choices.
  Regression evidence: [onboarding review fixes](testing/onboarding-review-fixes.tdd.md).
- **No 1.5 s success beat.** Progress moves the wizard on immediately; the
  next step opens with a "*MacBook Pro* is connected. Ready to run: Claude"
  fact, a polite announcement, and focus on its heading.
- **Not separately lazy-loaded.** The wizard lives in the signed-in app chunk,
  which is already split from the landing entry; a second split would put a
  `Suspense` reveal in front of the first screen every new User sees.
- **The rail chip is an icon square** with a `done/total` badge, matching the
  footer's other controls, rather than a text row.
- **Not yet built:** the one-line prerequisite copy on the Computers / Agents /
  Threads empty states, and the e2e run on the live harness. Unit and
  interaction tests cover the progress matrix and every step's branches.

Code: `web/src/lib/onboarding.ts` (progress), `web/src/hooks/useOnboarding.ts`
(stored choices), `web/src/components/onboarding/` (panel and steps),
`web/src/styles/onboarding.css`; backend `backend/relay/security/onboarding.py`
and migration `20261016_0098_account_onboarding`.
