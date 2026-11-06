# Project Manager and Relay MCP verification

Verified locally on 2026-11-06. This evidence supersedes the original drawer
implementation and its screenshots.

## Contract

- An actual Logical Agent holds the Project's `project_manager` roster role.
  Its global Agent Role stays unchanged; duplicate Project managers are refused.
- Chat opens an ordinary Agent Thread and queues no execution. Sending through
  the ordinary Thread endpoint dispatches the role holder with manager context.
- Proposals appear in that Thread. Owner Apply is editable, atomic and idempotent;
  new Tasks remain in backlog.
- Local Agent Runtimes receive a stdio MCP server. It invokes Relay API routes
  with a scoped, expiring and revocable bearer token. No owner Apply tool exists.

## Red and green evidence

The role and ordinary-conversation tests were committed while failing (invalid
role and missing conversation endpoint), before implementation. MCP API tests
initially failed with missing routes. Installer tests initially failed to build
because the installer module did not exist.

Browser verification then exposed two existing assumptions: Project conversations
redirected to the Dashboard, and their directory excluded them from Threads.
The manager Thread now participates in normal navigation and the Thread list.
A reload race was reproduced on mobile Chinese: session data arrived before
Project metadata and the old redirect won. Navigation waits for Project metadata;
the three browser variants passed three consecutive runs (nine checks).

## Results

| Verification | Result |
| --- | --- |
| Full Python regression run | 3,638 passed, 10 skipped; one old `planner` label assertion failed after automatic Project Manager assignment. Updated to the actual Project role; `pytest --lf` passed. |
| Final manager, MCP and Project-context API scenarios | 25 passed on SQLite. |
| Manager/MCP API and complete migration/schema checks on PostgreSQL 17 | 39 passed. Scratch database only. |
| Role, manager, MCP API and token-store coverage | 87% aggregate; Project roles 100%, token store 95%, MCP API 80%. 22 scenarios passed. |
| Built Node suites | 2,942 passed in the final full run; final Thread-directory suite 5 passed after its new scenario. |
| React interactions | 825 passed; final navigation/manager checks 8 passed. |
| Browser workflows | Desktop English, mobile English, mobile Chinese dark mode: opening, ordinary Thread navigation, reload, editing and owner Apply. Nine repeated checks passed after the reload fix. |
| MCP transport | Actual spawned stdio process negotiates, lists tools and calls a local HTTP server with the exact bearer token. Protocol output contains no token. |
| Runtime installation | Existing comments/settings/servers preserved; repeated installation adds no duplicates; edited or user-owned entries are refused. Fake home directories only. |
| Pi adapter | Generated extension starts the actual MCP process, discovers its nine tools, registers their schemas and shuts down. |
| Backend lint/types | Ruff passed; mypy zero errors across 417 source files. |
| Production build | Full workspace build passed; web rebuilt after final navigation changes. |
| Frontend lint | ESLint: zero errors, three pre-existing warnings. Stylelint passed. |
| Dependency audit | Zero reported vulnerabilities. |

The initial broad Node run passed 2,940 scenarios and caught a missing bundled
`jsonc-parser` dependency and an undefined CSS weight token. Both were corrected;
the 48 affected bundle, MCP and palette checks passed. The final broad Node run passed all 2,942 scenarios. The Project Manager
Thread-directory suite passed all five scenarios after its final addition.

Tests use real backend stores and real MCP/HTTP subprocess transport. Browser
API responses and Pi's registration host are fixtures. Authenticated sessions
against the five external model providers were not launched; these checks do
not claim provider authentication or live model quality.

## Rendered evidence

Fixture data, captured in the normal Agent conversation and visually inspected:

- [Desktop](../images/project-manager-desktop.png)
- [Mobile](../images/project-manager-mobile.png)
- [Chinese dark mode](../images/project-manager-mobile-zh-CN.png)

## Rollout

Run migrations 0113 and 0114, then install the rebuilt Computer client. On a local
Computer, ready runtimes get Relay MCP during daemon registration. Restart open
Agent Runtimes to load it. Existing runtime configuration is preserved, and token
revocation/rotation instructions are in [the implementation design](../project-manager-design.md).
