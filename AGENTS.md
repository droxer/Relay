# Relay Agent Guide

This repository uses TypeScript/Node.js for the core protocol, daemon, and web
client. The host backend/control plane is now Python-first and lives at the
repository root in `backend/` with `pyproject.toml`; keep new backend runtime code in Python unless a
compatibility shim must remain in TypeScript during migration.

This file is the single source of agent instructions; `CLAUDE.md` only imports
it.

## Domain Language

[`CONTEXT.md`](CONTEXT.md) is the canonical product glossary (Computer, Daemon
Node, Logical Agent, Agent Runtime, Placement, Thread/Task Workspace, Project,
…). Use its terms in code, UI copy, docs, and ADRs, avoid the synonyms each
entry lists, and check a new concept name against it before introducing one.
When the domain model changes, update `CONTEXT.md` in the same change.

<!-- context7 -->
## Context7

Use Context7 MCP to fetch current documentation whenever the user asks about a
library, framework, SDK, API, CLI tool, or cloud service, including well-known
tools such as React, Next.js, Prisma, Express, Tailwind, Django, or Spring Boot.
This includes API syntax, configuration, version migration, library-specific
debugging, setup instructions, and CLI tool usage. Prefer Context7 over web
search for library docs.

Do not use Context7 for refactoring, writing scripts from scratch, debugging
business logic, code review, or general programming concepts.

Steps:

1. Always start with `resolve-library-id` using the library name and the user's
   question, unless the user provides an exact library ID in `/org/project`
   format.
2. Pick the best match by exact name match, description relevance, code snippet
   count, source reputation, and benchmark score. Use version-specific IDs when
   the user mentions a version.
3. Run `query-docs` with the selected library ID and the user's full question.
4. Answer using the fetched docs.
<!-- context7 -->

<!-- CODEGRAPH_START -->
## CodeGraph

This project has a CodeGraph MCP server (`codegraph_*` tools) configured.
CodeGraph is a tree-sitter-parsed knowledge graph of every symbol, edge, and
file. Use it for structural questions.

Prefer CodeGraph for:

- `codegraph_search`: where a symbol is defined.
- `codegraph_callers`: what calls a function.
- `codegraph_callees`: what a function calls.
- `codegraph_impact`: what changing a symbol could affect.
- `codegraph_node`: a symbol's signature, source, or docstring.
- `codegraph_context`: focused context for a task or area.
- `codegraph_explore`: several related symbols' source at once.
- `codegraph_files`: files under a path.
- `codegraph_status`: index health.

Use native search such as `rg` for literal text queries, comments, log messages,
or after you already have a specific file open.

Rules of thumb:

- For architecture or trace questions, start with `codegraph_context`, then use
  one focused `codegraph_explore` if source is needed.
- Do not grep first when looking up a symbol by name.
- Do not chain many `codegraph_node` calls; use `codegraph_explore` for grouped
  source.
- The index watcher can lag writes by about 500 ms, so do not re-query
  immediately after editing a file.

If `.codegraph/` does not exist and the MCP server reports "not initialized,"
ask the user whether to run `codegraph init -i`.
<!-- CODEGRAPH_END -->

## Project Shape

- Workspace packages: root Python backend `backend/`,
  `packages/relay-core/`, `packages/relay-daemon/`,
  `packages/relay-supervisor/`, and top-level web frontend `web/`.
- Backend CLI entrypoint: `backend/relay/cli.py` (`relay`).
- Daemon CLI entrypoint: `packages/relay-daemon/src/cli.ts`.
- Tests: Python backend tests under `backend/tests/`, TypeScript package tests
  under `packages/*/tests/`, and web tests under `web/tests/`.
- Package manager: npm (workspaces).
- Local devbox image: `dockerfile`.
- Generated outputs: `dist/`, `packages/*/dist/`, `web/out/`, `web/.next/`,
  `node_modules/`, `.oci/`, and `.relay/` directories at any workspace level.

Node.js 22.19 or newer is required for the TypeScript packages. Python 3.12 or
newer and `uv` are required for the backend.

## Commands

- Install dependencies: `npm install`.
- Build packages: `make build-packages` builds `relay-core`, `relay-daemon`, and `relay-supervisor` only. Full build: `npm run build` (includes `web`).
- Test: `npm test` or `make test` — runs the TypeScript suite and the Python
  backend suite.
- Run one built test file: `node --test dist/packages/relay-core/tests/handoff.test.js`
  after a build. The canonical TypeScript test runner is `node --test` against
  the built JS.
- Run the Python backend: `make backend` (default port `8790`). Serves the
  exported web UI at the root path `/` and starts the background task scheduler
  by default. It first rebuilds the computer installer bundle
  (`backend/relay/computer/daemon.tar.gz`, what `relay update` installs) when
  the client sources are newer; the backend warns at startup when the bundle's
  `capabilities.json` lacks a capability it requires, since every computer it
  installs would read as outdated.
- Run the backend on a second port: `make serve`; default port is `8787`,
  override with `PORT=9000`. Same full application as `make backend`; only the
  port default differs.
- Run a daemon: `make daemon` (registers against `RELAY_BACKEND_URL`, polls for
  commands, and runs agent CLIs inside BoxLite by default; set
  `SANDBOX_MODE=none` for a user-local/manual node that should detect and
  run the current user's host agent installations).
- Run the web UI in dev mode (proxies API to the backend): `make web` (serves on `http://127.0.0.1:5000`).
- Run database migrations: `make backend-migrate` (Alembic; optionally pass `DATABASE_URL=<url>`).
- Backend task scheduler env: `RELAY_TASK_SCHEDULER_ENABLED` (default on; `0`
  disables it), `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS` (default `10`),
  `RELAY_TASK_SCHEDULER_MAX_DISPATCHES` (default `5`), and
  `RELAY_TASK_SCHEDULER_TIMEZONE` (IANA name for routine due dates; defaults to
  server-local). Failed dispatches block immediately and require manual retry;
  `RELAY_TASK_DISPATCH_MAX_FAILURES` is no longer used.
- Computer notification watcher interval:
  `RELAY_NOTIFICATION_WATCH_INTERVAL_SECONDS` (default `15`) — how often the
  backend checks computers for online/offline and outdated-client changes.
  Notices older than 90 days are pruned.
- Completed-run agent log tail cap: `RELAY_AGENT_RESULT_LOG_LIMIT` (default
  `262144` chars) — the fallback transcript keeps the head of long output.
- Daemon terminal echo of rendered agent output:
  `RELAY_DAEMON_ECHO_AGENT_OUTPUT` (default on). The supervisor sets it to `0`
  for every daemon it launches so supervisor logs stay lifecycle-only; output
  still streams to the backend and the daemon's JSONL run logs.
- Cloud computers: BoxLite is only the local-development stand-in (the
  default `local-process` provider); in production a cloud computer is a Fly
  Machine. `RELAY_MANAGED_NODE_PROVIDER=fly-machines` on the backend (set by
  `deploy/deploy.sh`) makes new managed computers Fly Machines, realized by
  the supervisor's `fly-machines` provider (`packages/relay-supervisor/src/fly-machines.ts`,
  configured by `RELAY_FLY_*`); the image is `make cloud-computer-image`. The
  machine is the sandbox, so those nodes run `sandboxMode` `none`
  (`managed_sandbox_mode_for` in `backend/relay/core/managed_node_policy.py`).
  See `docs/deployment.md`.
- Daemon runtime readiness check deadline:
  `RELAY_DAEMON_AGENT_PREFLIGHT_TIMEOUT_MS` (default `60000`) — a check that
  outlives it reports the runtime `unresponsive` instead of holding up
  registration.
- Stop backend, daemon, and BoxLite processes: `make stop`.
- Deploy to Railway behind Cloudflare, with the web UI as a Cloudflare Worker:
  `deploy/deploy.sh up` (config in git-ignored `deploy/.env`; see
  `deploy/README.md`). Test it against mock APIs with `deploy/tests/run.sh`.
- Install pre-commit hooks: `make pre-commit-install`.
- Run pre-commit hooks on all files: `make pre-commit-run`.
- Lint the backend: `ruff check backend` (config in `backend/pyproject.toml`; also a pre-commit hook). Every blind `except Exception` carries a `noqa: BLE001` reason.
- Type-check the backend: `cd backend && uv run mypy` (config in `backend/pyproject.toml`; also a pre-commit hook). It must stay at zero errors.
- Rebuild/export the devbox image only when the image changes: `make run-fresh`.
- Build/check/export devbox pieces manually: `make devbox-image`,
  `make devbox-check`, `make devbox-oci`.

Use separate `make backend`, `make daemon`, and `make web` processes for normal
execution. Do not tell users to run `make run-fresh` unless `dockerfile` or the
devbox image changed.

## Architecture

Relay is a local-first orchestration system split into a backend (control
plane) and daemons (execution plane). The backend owns sessions, tasks, and
the daemon registry and never executes agents; each daemon registers with the
backend, owns its sandbox (BoxLite VM or none), and runs the Claude Code, Pi,
Codex, and Kimi CLIs inside it. The backend stack is Python/FastAPI; the
daemon, web client, and shared agent runtime remain TypeScript during the
migration.

### Workspace layout

- **`relay-core`** — Shared protocol, pure helpers, and agent execution units
  (`index.ts` re-exports them). `state.ts` (agent state, `AgentName`),
  `agents.ts` (`AGENT_REGISTRY` — the per-agent definition table),
  `commands.ts`/`prompts.ts` (agent CLI argv + prompt text), `nodes.ts`
  (registry-driven `runAgentNode` execution unit; each agent CLI runs in
  BoxLite through `execStream`), `renderers.ts` (streaming JSONL → terminal
  text), `token-usage.ts` (`TokenUsage` type and `normalizeTokenUsage` —
  normalizes input/output/cache counts from any agent CLI output format),
  `guest.ts`/`env.ts` (guest auth provisioning, env/`REPO_ROOT`),
  `daemon-node-protocol.ts` (backend ⇄ daemon command/event types),
  `daemon-node-token.ts` (per-user token file under the daemon's private
  state directory, `~/.relay/daemon-nodes/<sandboxId>/credentials/<user>.token`,
  migrated automatically from the legacy `<workspace>/.relay/daemon-nodes/<user>.token`
  location), `format.ts` (ANSI helpers).
- **root `backend/`** — Python control plane. Pure backend: it queues work for
  daemons and never runs agent CLIs or BoxLite itself.
  - `backend/relay/app.py` — `create_app`: the FastAPI HTTP/SSE backend
    (canonical JSON API under `/api/v1`, persisted media under
    `/profile-images/`, and the exported web UI at `/`). It only orchestrates;
    `backend/relay/bootstrap/` holds the pieces — `stores.py` (which store
    backs each aggregate, `build_stores`), `runtime.py` (task scheduler, rate
    limiters), `http.py` (middleware, CORS, the JSON 500 handler).
  - `backend/relay/core/settings.py` — every environment-backed setting, read
    once and validated together (`AppSettings` → `app.state.settings`,
    `RegistrySettings`, `StreamSettings`); a bad value fails startup with one
    `SettingsError` naming each variable. Feature configs that already
    validate at startup (mail, blob storage, waitlist, password reset, the DB
    pool) keep their own `*_from_env`.
  - `backend/relay/api/` — HTTP routes in one subpackage per domain, each
    module one concern with its own `router`: `threads/` (reads, lifecycle,
    decisions, messages, the SSE `events` stream, artifacts), `tasks/`
    (records, runs, history, workspace files, automations; `payloads.py`
    shapes their requests and answers), `projects/` (`projects.py`,
    `access.py`, `links.py`), `agents/` (agents, teams, skills),
    `computers/` (user nodes, enrollment, the daemon wire, admin and managed
    nodes, sandboxes, device authorizations, the installer, node workspaces,
    plus `daemon_events.py` — the daemon event wire parser —
    `workspace_transport.py`, and `node_install.py`), `accounts/` (auth,
    password reset, waitlist, admin users, profile images, notifications),
    `admin/` (org settings, dashboard), `chat/` (integrations, gateway), and
    `web/` (`routes.py`, `ui.py`). `create_app` lists every router in
    `API_ROUTERS` (`backend/relay/app.py`); a route registered earlier wins a
    path two could match, and the web catch-all is registered last. Shared
    plumbing stays at the root: `actors.py` (who is calling: session,
    chat-service, and node-token actors; record access), `bodies.py` (bounded
    JSON body, field coercion), `schemas.py`, `conditional_get.py`,
    `contract.py` (route groups; every `/admin` route sits behind a
    router-level `require_admin`), and `deps.py` (`AppContext`, built once by
    `create_app` as `app.state.context`; no other `api` module reads
    `app.state` — `tests/unit/test_api_state_access.py`). The caller's shape
    is the `Actor` TypedDict in `security/actor.py`.
  - `backend/relay/core/` — ids, models, timestamps, the daemon capability
    vocabulary (`daemon_capabilities.py`), user preferences, org policy
    defaults, workspace layout constants, environment loading, logging.
  - `backend/relay/persistence/` — event-sourced stores, one subpackage per
    aggregate, each with its store in `store.py`: `session/`, `task/`,
    `daemon/` (plus `managed_nodes.py`), `agent/` (plus `placements.py`),
    `team/`, `project/`, `skill/` (plus `objects.py`), `automation/`,
    `notification/`, `org/` (`settings.py`, `admin_tokens.py`), `account/`
    (`profile_images.py`, `waitlist.py`, `handle_backfill.py`), and `blob/`.
    `ops/` holds the backup and storage report. The package root keeps only what
    every store shares: `engine.py` (engines, `store_transaction`,
    `after_store_commit`), `events.py` (event constructors), `db_time.py`,
    `token_usage.py`, `validation.py`, `sql.py`/`schema.py`/`tables/`,
    `listeners.py`, `resource_lock.py`, and the store Protocols in
    `protocols.py`. Reducers live with their aggregate
    (`session/reducer.py`, `task/reducer.py`). The three largest database
    stores are assembled from one mixin per concern in their package —
    `daemon/` (nodes, commands, run requests, workspace responses,
    maintenance, plus `rows.py`/`rules.py`), `session/` (lifecycle, events,
    deletion, artifacts, reads), `task/` (writes, dispatch, routines, links,
    reads, plus `events.py`/`rules.py`) — each with a `state.py` declaring
    the shared engine and tables. Import from the defining module; there is
    no re-export facade. Every
    aggregate (accounts, sessions, tasks, daemon nodes, agents, teams,
    placements, chat integrations) is database-only; tests build them on
    sqlite through `backend/tests/store_fixtures.py`. Retired file-backed
    stores are no longer imported at startup or through the CLI.
    `listeners.py` is the one change-hint plumbing every store fires after a
    commit. Every table is declared once in `persistence/tables/`
    (importing only SQLAlchemy, `sql.py`, and `core`), and `schema.py`
    aggregates them, so no store imports another to build the schema.
    Reducers never mutate nested collections of the snapshot they are given
    (`tests/unit/test_reducer_isolation.py`).
  - `backend/relay/security/` — `auth.py` (`DatabaseAccountAuthStore`, the
    database account store, assembled from one mixin per concern:
    `auth_accounts.py`, `auth_users.py`, `auth_departments.py`,
    `auth_sessions.py` (login sessions), over `auth_state.py`; `auth_rows.py`
    maps records to rows), `request_auth.py` (session cookie and
    `require_user_session`/`require_admin_session`), `admin_token.py`,
    `credentials.py` (password and session-token hashing), `entity_ids.py`
    (stable user/department ids), `user_handles.py`, `passwords.py`, `password_resets.py`,
    `rate_limit.py`.
  - `backend/relay/sessions/` — `controller.py` (session mutation),
    `bridge.py`/`conversation.py`/`handoff.py` (continuity and handoff).
  - `backend/relay/daemon_registry/` — `DaemonNodeRegistry` (`registry.py`)
    is assembled from one mixin per concern, grouped by subpackage:
    `nodes/` (`registration.py`, `liveness.py`, `admin.py`), `dispatch/`
    (`commands.py` — queue, leases, heartbeats; `admission.py`;
    `delivery.py` with its pure `run_state.py`/`run_start.py`;
    `follow_up.py`), and `runs/` (`progression.py` with its pure
    `finalization.py`, `transitions.py`, `failure.py`, `completion.py`,
    `events.py`, `reaper.py`, plus `artifacts.py` and `run_cursor.py`).
    `state.py` declares their shared state, `config.py` the tunables (read
    as `config.NAME` so tests can patch them), `records.py` the pure record
    helpers, `scheduling.py` run capacity, `credentials.py` token checks,
    `locks.py` the two lock levels (global before node; taking the global
    lock under a node lock raises `LockOrderError`). `node_backend.py`
    (`ServerDaemonNodeBackend`, run dispatch) sits above the registry and is
    assembled from the `intake/` mixins (`idempotency.py`, `validation.py`,
    `ownership.py`, `intent.py`), which share its layer.
  - `backend/relay/collaboration/` — `service.py` (`CollaborationConductor`:
    turns a message, recovery, or legacy run into one round manifest),
    `manifest.py` (pure manifest/work-graph compilation), `styles.py` (team
    styles and slot filling), and the pure round policy in `work.py`
    (work-report acceptance, findings repair, consultations, lead plans) and
    `policy.py` (`next_work_transition`, runtime-failure repair, the repair
    budgets). The daemon registry applies these transitions; it should not
    decide them.
  - Domain packages (application layer), one per aggregate, each with an
    empty `__init__` and short module names:
    `accounts/` (`password_reset`, `user_lifecycle`, `waitlist`),
    `agents/` (`binding`, `creation`, `location`, `routing`),
    `teams/` (`computer`, `dispatch`, `membership`),
    `projects/` (`access`, `catalog`, `context`, `deletion`, `runtime`,
    `setup`, `setup_result`),
    `tasks/` (`assignment`, `creation`, `deletion`, `dispatch`, `placement`,
    `requests`, `rounds`, `start`, `update`, `workspace`, `issue_triage`, …),
    `skills/` (`assignments`, `bundle`, `grants`, `git_import`),
    `computer/` (`limits`, `names`, `node_agents`, `workspace_query`, beside
    the installer assets), `execution/` (`lifecycle`, `session_deletion`),
    and `realtime/` (`event_notifier`). There is no generic `services`
    package; put a new use case in the package of the aggregate it changes.
  - `backend/relay/tasks/scheduler.py` — background scheduler that promotes
    due routines and dispatches assigned tasks to ready daemon nodes; one
    malformed task is logged and skipped, never stalls the queue. It sits one
    layer above the rest of `tasks/`, which never imports it.
  - `backend/relay/automations/` — automation triggers, schedule, clock,
    matcher, and firing (see the Automations invariant).
  - `backend/relay/chat/integrations.py` — chat provider integration glue.
  - `backend/relay/migrations_runtime/startup.py` — idempotent record repairs
    run at boot (`RELAY_STARTUP_REPAIRS=0` skips them); schema changes belong
    in Alembic.
  - Database migrations live under `backend/migrations/` (Alembic); run with
    `make backend-migrate`.
- **`relay-daemon`** — Execution plane. The daemon service that connects
  agents to the backend.
  - `index.ts` — Daemon loop: registers with the backend, polls for commands,
    runs agent CLIs, posts `run.output`/`run.completed`/`run.failed`/`run.cancelled`
    events back. Survives backend restarts by retrying with backoff and
    re-registering when a poll is rejected. Sandbox modes: `boxlite`
    (managed/default; the daemon boots BoxLite guests lazily — one per
    concurrently running workspace, up to its run capacity
    (`RELAY_DAEMON_MAX_CONCURRENT_RUNS`, default 3), each mounting only that
    workspace — and runs agents inside them; `guest-pool.ts` owns that
    lifecycle) or `none` (manual/local; agents run as processes in the
    daemon's current host environment, using that user's existing agent home
    by default). The host environment may be a user workstation or an
    already-isolated agent box. A Windows computer runs in `none` mode only:
    host commands go through Git Bash (`local-shell.ts`, never WSL) and the
    installer registers a Task Scheduler logon task (`windows-service.ts`,
    `windows-service-host.ts`) in place of a LaunchAgent or systemd unit.
  - `box.ts` / `execution.ts` / `sandbox-session.ts` — BoxLite VM setup,
    `BoxLiteExecutionManager`, `startOrchestratorSession`/`withOrchestratorSession`,
    sandbox session lifecycle, and agent readiness preflight
    (`ensureAgentReady`).
- **root `web/`** — Next.js web UI (static export served by the backend at the
  root path `/`; the backend registers the web catch-all last so explicit API
  routes take precedence; dev mode proxies API routes to the backend). Primary
  surfaces: threads, task backlog, recurring automations, agent configuration,
  teams, and channels. Includes the admin page (`AdminPage.tsx`) with a
  dashboard (`components/admin/dashboard/` — `DashboardView`, `KpiTile`,
  `NodeStatusCard`, `ActivityChart`, `ActivityFeed`, `TokenUsageChart`,
  `TopUsers`), node management (`NodeCard`, `AssignNodeDrawer`), and
  executor management (`ManageExecutorsDrawer`). The page's root is
  `components/RelayEntry.tsx`: a visitor at `/` without the
  `relay-web.signedIn` hint gets the landing page alone, and `App.tsx` — with
  every signed-in surface and `styles/app.css` — is one chunk that loads
  beside it otherwise. Keep that boundary: the global `styles.css` holds only
  tokens, the landing page, and the auth gate, and a heavy surface reached
  from an always-rendered component (as `ProjectWorkspacePage` is from
  `ThreadsView`) is `lazy`-loaded. The entry renders the loaded app directly
  rather than through `Suspense`, whose ~300 ms reveal throttle would delay
  every load.

### Backend / daemon / client token contract

- The per-user token lives at `~/.relay/daemon-nodes/<sandboxId>/credentials/<user>.token` on the daemon's host (created by whichever side starts first via `ensureDaemonNodeToken`); this directory must never be mounted into an agent sandbox. A one-time migration reads and deletes any token found at the legacy `<workspace>/.relay/daemon-nodes/<user>.token` path. `RELAY_DAEMON_TOKEN` overrides it (`RELAY_DAEMON_NODE_TOKEN` is the accepted legacy name). The backend stores only a SHA-256 hash; a fresh provision or explicit reissue returns the plaintext once. The legacy reveal route answers 409. Browser device setup issues the runtime credential at single-use redemption. Migration 0089 clears legacy database secrets, and the file-store import never carries a legacy node secret into the database.
- Re-registering a sandbox with a different token is rejected (401) — registration cannot rotate or hijack tokens. The daemon exits successfully on 401/410, asking the owner to run setup again after credential rejection. New nodes require enrollment or authenticated admin registration.
- An authorized command poll revives a `stopped`/`failed` daemon record to `ready` (covers backend restarts); provisioning by user prefers the live daemon over offline placeholders.
- **Alive is not listening.** `online` comes from any authenticated observation within the liveness timeout (default 30 s; the daemon beats every fifth of it); `dispatchable` additionally needs a fresh command poll (`lastPollAt`, advanced only by `take_commands`, kept across registrations) or no poll yet. Dispatch admission uses `dispatchable`; the web and watcher read `online`. A `draining` heartbeat pins the poll observation to the epoch and the daemon sends it before aborting runs on shutdown. The backend advertises `heartbeat.features` (`poll-liveness`, `state`) and the daemon skips beats while a poll is open only when told it may. See `docs/node-heartbeats.md`.
- Deleting a non-managed node leaves a tombstone (`status: "deleted"` + `retiredAt`) instead of dropping the row — `retire_deleted` (`daemon_registry/nodes/admin.py`). Registrations, polls, heartbeats, and events from a deleted node answer `410`, matched by node id and by workspace identity so a daemon restart cannot resurrect it; the daemon shuts down on `410`. Re-enrolling the machine works because provisioning a fresh record gives registration a live row to land on.
- Wire routes (`/daemon-nodes/...`) and on-disk paths keep the historical `daemon-node` names for compatibility.

## Implementation Notes

- Use BoxLite's Node SDK (`@boxlite-ai/boxlite`) for VM lifecycle and command
  execution.
- `execStream()` should stream stdout/stderr while also collecting output for
  routing and logs.
- Claude uses `--output-format stream-json`; render JSONL through
  `JsonLineRenderer` instead of printing raw JSON.
- Codex uses `exec --json`; render JSONL through `JsonLineRenderer` instead of
  printing raw JSON.
- Keep terminal output readable: section headers, status labels, aligned startup
  fields, and no raw JSON events.

## Invariants

- **Backend imports point down one layer stack.** core → persistence → security/chat → sessions → daemon_registry → application (the domain packages — accounts, agents, teams, projects, tasks, skills, computer, execution, realtime — plus collaboration, automations, notifications, and the registry's `node_backend` with its `intake/`) → `tasks.scheduler` → api → app/bootstrap/cli. `backend/tests/unit/test_layering.py` enforces it: no import cycles, no upward import, relay imports at module level only, and the package `__init__`s listed in its `EMPTY_PACKAGES` re-export nothing. Pure rules every layer shares (collaboration policy/work/manifest, the automation model, notification rules, task-workspace and issue-triage rules) are listed in its `POLICY_MODULES` and may import only `core` and each other; put a new shared rule there rather than importing upward. `backend/tests/api/test_route_auth.py` walks the route table: every route not on its public allowlist must refuse an anonymous caller, and every `/admin` route a signed-in non-admin.
- **Backend modules and packages stay small.** A module stays at or under 800 lines and a package's own modules under 5,000 lines (`backend/tests/unit/test_module_size.py`). Split a growing module by concern rather than extending it — the daemon, session, and task stores (one mixin per concern) and the domain packages are the pattern — and never add a catch-all module (`common`, `utils`, `services`, a re-export facade). The test's allowlists are ceilings for code already over budget: they may only shrink, and an entry that falls under budget must be removed.
- **The backend never executes agents.** All agent execution flows through daemon commands (`ServerDaemonNodeBackend.run` → registry queue → daemon poll). Do not reintroduce in-process execution paths into the Python backend. The background `TaskScheduler` (`backend/relay/tasks/scheduler.py`) only promotes due routines and dispatches already-assigned tasks through the same daemon path; disable it with `RELAY_TASK_SCHEDULER_ENABLED=0` when needed.
- **Never mock or seed data in the server.** It reads the configured database and real operational state under `.relay/`.
- **A delivered execution reservation releases only on daemon exit evidence or a recorded human assertion.** The assertion paths are the reconcile endpoint (`POST /threads/{id}/execution/reconcile`) and thread deletion itself once the execution requires recovery (`canReportGone`); both append `session.execution_reconciled` with the actor, so the log never reads as observed exit. A dead computer's run becomes reportable (`execution_lost`, `execution_interrupted`, or a stop past its grace) but never self-releases. Every overdue deletion must have a way out — a person's action or automatic progress; `backend/tests/unit/test_execution_escape.py` sweeps the execution-status inputs to enforce it, so extend its axes with any new phase, status, or recovery reason.
- **A personal computer is bounded; admin hardware is not.** How many `nodeLocation: "user-device"` computers a user may enroll comes from `users.max_local_computers` when one is pinned, and the single-row `org_settings` table otherwise (`backend/relay/persistence/org/settings.py`, default 3, range 0–50). `backend/relay/computer/limits.py` is the one seam that resolves and enforces it; call `assert_local_computer_allowed` only where a computer would actually be created (self-enrollment and the admin create route), never on adoption of a workspace the user already enrolled — a user at their limit must still be able to re-enroll a machine they have. Enforcement is creation-only: lowering a limit never disconnects an existing computer. The override lives on the users table; `GET /admin/settings` still reports `capabilities.userEdits` (always `true` now that accounts are database-only) because the web UI reads it.
- **A user's own computer is theirs alone.** An owned `nodeLocation: "user-device"` computer is read-only to an admin: the console lists it but offers only Copy ID, and every mutating route — rename, runtimes, role defaults/overrides, runtime refresh, unassign, delete, on both the `/daemon-nodes` and `/admin/daemon-nodes` wires — answers 403 to anyone but its owner. `backend/relay/computer/access.py` (`actor_may_manage_computer`, `admin_may_manage_computer`) is the one seam; the web mirror is `isPersonalComputer` (`web/src/lib/adminHelpers.ts`). Managed and unassigned hardware stays the admin's to manage.
- **"Employee" is the pre-rename name of User; Account is the login.** Migration `20261015_0094` renamed `employees` → `users`, `auth_users` → `auth_accounts`, and every `*employee*` column, index, and constraint (generated names included); `20261015_0095` rewrites the JSON keys in event payloads and snapshots in committed, resumable batches, and its downgrade maps back exactly `LEGACY_KEYS`. State that never passes through it — bodies on `/daemon-node*`, `/computer-authorizations`, `/admin/daemon-nodes`, and `/admin/managed-nodes` routes — is upgraded on read by `backend/relay/core/legacy_names.py`; the daemon side is `relay-daemon/src/legacy-names.ts` (`--employee-id`, `RELAY_EMPLOYEE_ID`, installed-service argv). Responses an older daemon reads (`/computer-authorizations/token`, `/daemon-node-enrollments`) still echo `employeeId`. Two `employee` strings stay on purpose: handle-derived ids hash under `USER_ENTITY_KIND = "employee"` (`security/entity_ids.py`), and the password blocklist. Older supervisors keep working through the deprecated `GET /admin/employees`, `employeeId` mirrored onto `/admin/daemon-nodes` records (`with_legacy_user_id`), and body upgrades on `/admin/daemon-nodes` and `/admin/managed-nodes`; drop these once every supervisor is upgraded. Never write a new `employee` name.
- **A user's id is a key; their handle is the name.** `users.id` is a UUID (uuid5 of the handle for anything created through the admin form; on SQLite, a user imported from the retired accounts file keeps its handle-shaped id so the rows that reference it still match) and stays the foreign key everywhere; `users.handle` is the unique `@name` every admin surface renders. Resolve a handle through `auth_store.resolve_user_id` (it consults the handle column before the uuid5 mapping, because backfilled rows have an id that is not uuid5 of their handle), and never render `user.id` as a handle — the web helpers `userHandleOf` / `handleForUserId` in `web/src/lib/userHandle.ts` are the one seam, and they never fall back to the raw UUID. Handles are validated on both sides by `normalize_user_handle` (`backend/relay/security/user_handles.py`) and its mirror in the same web module. `POST /admin/users` rejects a handle that already belongs to a live user (409) rather than letting `ensure_user` reuse and overwrite that row. The backfill rule for migration `20260831_0065` lives in `backend/relay/persistence/account/handle_backfill.py` so the migration and `relay rehearse-user-handles` (read-only; run it against a copy of production first) cannot disagree.
- **One password policy, in `backend/relay/security/passwords.py`.** Length plus a blocklist, context words (the account's own username/handle/name/email), and degenerate shapes — no composition rules, per NIST SP 800-63B. Both stores' `create_user` call `validate_password`, and both `bootstrap_with_token` paths delegate to `create_user`, so no path sets a password without it; pass the account's `identifiers` at every call site. `web/src/lib/passwordPolicy.ts` mirrors every rule except the blocklist — that one stays server-side deliberately, since a few hundred entries duplicated in two languages would drift.
- **Sessions and tasks carry an owner.** `RelaySession.ownerUserId` / `RelayTask.ownerUserId` (set from the `session.created` / `task.created` events) attribute work to the user whose agent runs it; `HumanDecision.actorUserId` records who approved/rejected/handed off. `ServerDaemonNodeBackend.run` threads the sandbox's `userId` into the owner, and `assert_session_owned_by_user` (`daemon_registry/intake/ownership.py`) is the authorization seam — a user's agent may only act on sessions its user owns (ownerless legacy sessions are allowed). This is where the future task-scope / tool-policy / approval checks belong; keep it the single checkpoint rather than scattering ownership checks.
- **A thread action speaks only for the task it is executing.** Sessions carry no `taskId`, and task links are history, never execution authority. Stop, cancel, mark-done, reconcile, and delete resolve the task through `thread_task_scope` (`backend/relay/sessions/task_scope.py`) — the active run request's `taskId`, else the active round's task `workScope` while that task is in flight — and resolve it *before* cancelling, because an undelivered request stops being active and an `assigned` task left behind is re-dispatched by the scheduler. Task rounds retain their original `taskExecutionOwner`; never borrow the task's current claim for an old round. Older rounds need a matching retained run request to establish ownership. Completion retries repair missing task writes under the original claim without duplicating the session event. A finished agent turn writes no task status; the round's closeout picks it, so status-change automations never see a phantom `waiting_for_human`. A round that stopped to ask closes its thread `completed` with `workOutcome: "blocked"`; count that as waiting through `session_awaits_human` / `isAwaitingHuman` (`web/src/lib/workflow.ts`), never `status` alone.
- **Event log is authoritative.** All session/task state changes go through the Python `SessionStore.append_event` / `TaskStore.append_event`. Database snapshots and materialized fields are derived. Never mutate snapshot fields directly outside the store's replay.
- **Immutability.** Session/task mutations return new objects (`mergeAgentState`, spread updates). Existing pattern; preserve it.
- **Pi CLI version skew.** Pi versions differ — use `-P` only when `pi --help` advertises `-P`/`--print-streaming`, otherwise `-p`. `commands.ts` already handles this; keep both paths working.
- **Agent identity is registry-driven.** Four agents are recognized: `claude`, `pi`, `codex`, `kimi` (`AgentName` in `relay-core/src/state.ts`). The single source of truth is `AGENT_REGISTRY` in `relay-core/src/agents.ts` — command builder, renderer, preflight, failure budget, capabilities (only `codex` has `review`), role, and guest-auth flag. Dispatch sites use `getAgent`/`AGENT_NAMES`/`isAgentName` instead of literal switches, and per-agent failure counts live in `AgentState.agent_failures` (use `failureCount`/`withFailure`). Adding an agent = one `AGENT_REGISTRY` entry plus its CLI specifics: a command builder in `commands.ts`, a prompt in `prompts.ts`, any guest-auth file writes in the daemon (`relay-daemon/src/index.ts` `ensureHostAgentReady` + `box.ts`), and — because the web app cannot import the node-only registry — mirror the agent in `App.tsx`/`MessageBlock.tsx` literals and the `agent.<name>` i18n keys (the `Record<AgentName, …>` types enforce this). Extra agents are invoked through explicit assignment, while web chat uses the composer agent picker. Kimi's CLI flags in `buildKimiActionCommand` are provisional — confirm against the installed Kimi CLI. Each agent supports two task modes — `action` (do the work) and `review` (`AgentTaskMode` in `relay-core/src/state.ts`).
- **A turn belongs to a logical agent, not an executor kind.** Several named agents can share one `executorKind`, so `AgentName` never identifies who ran a turn. The dispatched agent id is persisted as `logicalAgentId` on the `agent.started` event and on `RelaySession.agentRuns`; web surfaces resolve names and re-dispatch (`labelForAgentRun` in `web/src/lib/agentDisplayNames.ts`, `DerivedMessage.agentId`, retry/rerun lookups) from that id, falling back to the per-executor name map only for legacy runs that carry none. Never label or route a chat turn by executor kind alone.
- **Token usage flows through `normalizeTokenUsage`.** All agent CLI output formats (Claude, Codex, Pi, Kimi) must be normalized through `normalizeTokenUsage` in `relay-core/src/token-usage.ts` before storing on the session. Cache is split into `cacheRead` and `cacheWrite` (`cache` stays their sum; a legacy record's combined `cache` counts as reads — `splitCache`). Every headline — the thread turn badge and the dashboard KPI/bars — shows `freshTokens` (input + output + cache writes), never `total`, because cache reads dominate a long run while costing a tenth of input. The backend stores per-session totals and a per-run ledger (`session_run_token_usage`) that also holds a zero `reported = false` row for a run that *completed* without counts, so the dashboard (`GET /api/v1/admin/dashboard/tokens?tz=<IANA>`, days bucketed in the viewer's zone) names unmeasured runtimes from data rather than a hardcoded list. Cancelled and failed runs carry whatever usage the process reported.
- **Generated workspace artifacts are daemon-reported.** The daemon diffs document-type workspace files around each successful run (`relay-daemon/src/generated-files.ts`) and reports them in `run.completed` (`generatedFiles`, with inline base64 content for small files), advertising the `generated-files` capability at registration. The backend indexes them as `workspace_file` artifacts via `SessionStore.index_workspace_artifact`, keeping a content snapshot so downloads survive workspace rewrites/deletes. A daemon that reports nothing indexes nothing: there is no backend-side filesystem walk, so the backend never needs to share a filesystem with a daemon. A daemon without the `produced-files` capability reports only document types and is indexed under the older, narrower rule. A re-generated file gets a new artifact attributed to the producing run; `workspace_artifacts` (`backend/relay/persistence/session/workspace_artifacts.py`, keyed by the same `workspace_file_key` as the session store file projection) dedupes the index to the newest record per file, and `GET /api/v1/tasks/{id}/artifacts` rolls artifacts up to the task by aggregating its linked sessions with the same newest-per-file dedupe. Keep the extension allowlist free of ambiguous types (no `.key`).
- **Agent home workspace.** An agent's files live in its home (`agents/agent-<b64>/` under the node mount) while a run is active, but agent-home directories are not browsed through daemon `workspace.list`/`workspace.read` commands anymore. Live workspace reads use the shared node/project root and the `workspace-read-shared` capability; generated file snapshots remain the durable record for offline browsing.
- **A task's workspace is derived, not stored.** A backlog task's rounds share `tasks/<taskId>/` under the node root, and every run of one automation shares `tasks/<sourceRoutineId>/`, so an automation can keep state across runs. `backend/relay/tasks/workspace.py` is the one seam that resolves it — never rebuild the path at a call site. Inside a workspace, each thread records its status and handoff under `threads/<threadId>/` (`HANDOFF.md`, `HANDOFF.json`), and deliverables go where `workspace_artifacts_dir` (`backend/relay/core/workspace_layout.py`) says: `artifacts/` for a thread or task, `artifacts/<taskId>/` for one automation run, and nowhere special for a project — the project directory *is* the deliverable location, so no `artifacts/` is created there. The backend sends it as `artifactsDir` on `run.start` (null for a project) and reports it as `workspaceArtifactsDir` on a task and `artifactsDir` on a run-ledger row, which the web file browsers open on (`workspaceFileRoots` in `web/src/lib/workspaceFileTabs.ts`). A daemon without the `artifact-layout` capability keeps the older per-occurrence directory (`tasks/<sourceRoutineId>/<taskId>/`) and an `artifacts/` in every workspace, so an automation bound before this layout keeps browsing where it wrote. A task dispatched into a project keeps the project workspace; the project always wins. The layout is chosen at dispatch against the already-chosen node, so a daemon without the `task-workspaces` capability degrades to the per-thread directory instead of failing the run (a project *is* its workspace, so its gate stays fatal). Because rounds now share a directory, the daemon's `workspaceRunGate` must key on the task workspace or concurrent rounds overwrite each other.
- **The waitlist is off by default and is not sign-up; inviting is always on.** `RELAY_WAITLIST_ENABLED=1` mounts only the public join, `POST /waitlist` (`is_waitlist_route` in `backend/relay/api/contract.py`); the invite pages (`/waitlist/invites/*`) and the admin queue (`/admin/waitlist*`) are mounted on every install, because an admin can invite an address directly (`POST /admin/waitlist/invitations`, the console's "Invite by email"). That invitation reuses the address's entry (source `admin-invite`), skips the queue cap, and is refused with 409 for an address a live Account already holds; a joined entry whose User was since deleted is reopened (`reopen_departed`) and invited again, while an unlinked claim stays closed. The web learns the switch at runtime from `GET /auth/status` → `waitlistEnabled` and `GET /admin/settings` → `capabilities.waitlist` (the admin section reads "Waitlist" when on, "Invitations" when off), so there is no build flag. Invites are links by default: the admin copies each one and nothing is mailed unless `RELAY_WAITLIST_INVITE_EMAIL=1` (a link-only invite answers `delivery: null` and records no delivery). With it on, an invite is emailed only when its link is built on `trusted_web_origin` (`core/deploy_config.py`), never on the request's Host; without one the admin still gets the link (`capabilities.inviteEmail` says which). `deploy/deploy.sh` sets it to `1` for the hosted Railway deploy unless `deploy/.env` says `0`; the backend default stays off for every other install. `backend/relay/accounts/waitlist.py` is the one seam for transitions; `persistence/account/waitlist.py` is a plain row store (not an event log) whose conditional updates make an invite single-use — `claim_invite` before creating the account, `release_claim` if that fails. Public answers stay uniform: every valid join is `202` (new, known, declined, honeypot) and every dead token one `404`; the confirmation email is sent in a background task so its latency cannot reveal a new address. Invite tokens ride the URL fragment and POST bodies (`/waitlist/invites/lookup`, `/accept`) — never a path, so no access log keeps one — and only their hash is stored; batch invites return their links before sending (`queued`). Email goes through `backend/relay/notifications/mailer.py` (`CloudflareMailer` via the Cloudflare Email Service REST API, else `NullMailer`); a send never raises or changes an entry's status, and a partial `RELAY_MAIL_*` set fails startup. Plan: `docs/waitlist-design.md`.
- **A password reset proves the inbox and signs nobody in.** Asking for a link (`POST /auth/password-reset`) exists only while mail and a public origin are configured (`PasswordResetService.self_serve_enabled` → `GET /auth/status` `passwordResetEnabled`) — an emailed link takes its origin from `trusted_web_origin`, never the request's `Host`, which anyone can forge; redeeming one never needs mail, because `POST /admin/users/{id}/password-reset` always returns the link for an admin to hand over. `backend/relay/accounts/password_reset.py` decides who a request reaches and what is sent; `backend/relay/security/password_resets.py` keeps the records in `auth_password_resets`, beside the accounts. The request answers `202` whatever matched and does its lookup and send in a background task; every dead link is one `404`. An Account's address is its own `email`, else its User's; an email shared by several Accounts sends each its own link, up to three per request. The public request is rate limited per IP only: a per-identifier bucket would let anyone lock a person out. Issuing a link retires the Account's older ones, a per-Account cooldown and hourly cap live in the store so they hold across replicas, and completion claims the link, applies `validate_password` (a refusal rolls the claim back), sets the hash, and deletes every session in one transaction — then emails a "password changed" notice and leaves sign-in to `/auth/login`. Tokens ride the URL fragment (`/reset-password#token=…`) and POST bodies; only their SHA-256 is stored, and no log line carries a token or an address. Plan: `docs/password-reset-design.md`.
- **Chat channels are off by default.** `RELAY_CHANNELS_ENABLED=1` is what mounts the chat routes (`/admin/chat-integrations`, `/internal/chat/*`) — `is_channel_route` in `backend/relay/api/contract.py` is the one seam that classifies them — and `NEXT_PUBLIC_RELAY_CHANNELS_ENABLED=1` (`web/src/lib/features.ts`) is what gives the web build its `/channels` route, palette command, and `G H` chord. Both must be set together. The chat store is still built and tested (the `relay-chat` gateway package was removed); a new chat route must sit under one of those two prefixes or it escapes the switch.
- **Assignment follows the computer, not the roster.** Anyone who shares a computer shares its workspace, so work there may go to any agent on it or any team whose whole roster is placed on it. A project task may name a non-member agent or a team on the project's computer (`project_task_assignment_error` in `backend/relay/projects/runtime.py` is the one admission rule; a member the project *disabled* stays refused), and it still runs in the project workspace, and its thread stays the project's room — the team never becomes the thread's team. A started thread may address a team on its computer (`addressTeamId`) or, in a team thread, an agent outside the team (`CollaborationConductor._round_team_id`); the thread keeps its own team, and recovery plus the legacy `/agent-runs` path keep the strict roster. A project thread is the exception: it stays the project's room, so addressing a team there is refused (`project_team_conflict`) — route team work into a project through a task instead. Inside a project thread any agent on the project's computer may still be addressed by name, a bare message in a project without a crew goes to the agents already in the thread, and an unaddressed answer to a question asked by a round outside the crew goes back to that round's agents (`project_thread_assignments`, `CollaborationConductor._asking_outside_agent_ids`; web mirrors `projectThreadRoster` / `projectRoomAgentIds`). Dispatch requires a crew and lead only for a task that names no agent or team. The web mirrors the rule in `agentOnComputer` / `teamOnComputer` / `teamSharesOneComputer` (`web/src/lib/taskAssignment.ts`) and `threadRoundTeam` (`web/src/lib/messageRouting.ts`). Team setup enforces the same shape up front: a team picks its computer first and records `computerId`, and every member must be placed there (`backend/relay/teams/computer.py` is the one seam; the web mirror is `web/src/lib/teamComputer.ts`) — the same rule a project's crew already follows through `validate_project_roster`.
- **A project may link an existing directory; the computer decides which.** A linked project's `workspaceSubpath` is `links/<id>` (never `projects/<id>`), and the project records the directory's canonical path as `workspaceHostPath`. Only the daemon maps `links/<id>` to a directory (`relay-daemon/src/project-links.ts`): it accepts one inside its locally configured roots (`RELAY_DAEMON_PROJECT_ROOTS`, path-delimited; default the user's home on a `none`-mode computer and nothing under BoxLite), never one that overlaps its workspace root (in either direction) or `~/.relay` — compared case-insensitively on macOS and Windows —, and re-validates on every resolve, so a vanished or moved link fails its run instead of being recreated empty. The backend relays the choice through a `workspace.link` command (`backend/relay/api/projects/links.py`; `POST /projects/workspace-check` is its dry run) behind the `project-links` capability, and every registration response's `projectLinks` replaces the daemon's in-memory map. Deleting a linked project sends no `workspace.delete` and reports `workspaceCleanup: "kept"`; its artifacts record paths under `workspaceHostPath`. The link is set at creation and cannot be patched.
- **A project's files outlive its node, and deleting it always has a way out.** `backend/relay/projects/deletion.py` is the one cascade: it takes the task-deletion lock (`TASK_DELETION_LOCK`) before any row, settles each thread the way deleting it alone would (`ExecutionLifecycle.settle_for_deletion`, so a run Relay gave up on never blocks), refuses only live work and names those threads in a 409, and unlinks tasks outside the project instead of deleting them. Cleanup is queued on the computer's best live node, else on its newest retired record, and `DaemonNodeRegistry.rehome_workspace_cleanups` (`daemon_registry/nodes/admin.py`) hands it to the next live incarnation on registration or node deletion; a computer Relay no longer knows is no reason to refuse, and the response reports `workspaceCleanup: "orphaned"`.
- **A project's brief reaches every run; agents propose, owners apply.** `goal`/`context` ride the round's pinned project snapshot, and the backend renders them with the enabled crew into the `[Project]` prompt section (`project_context_brief` in `backend/relay/projects/context.py`); the daemon mirrors it to `.relay/PROJECT.md`. Agent-drafted setup (`backend/relay/projects/setup.py`, `POST /projects/{id}/setup`) is an ordinary daemon run whose drafter is admitted by the project-task rule, not roster membership; its proposal (`.relay/project-setup-<runId>.json`, reported as `projectSetup` behind the `project-setup` capability) is only stored — applying it is the normal project PATCH plus `setupResolution`, so roster rules run when it takes effect. Round-result `contextSuggestions` likewise wait on the project until the owner adopts or dismisses them (`resolveContextSuggestions`); nothing an agent writes changes the brief by itself. See ADR-022.
- **A task's number is per scope and never reused.** A project counts its tasks, a user counts their other tasks, and separately their automations (`task_number_scope` in `backend/relay/persistence/task/numbering.py` is the one seam). The number rides on `task.created`, or on `task.project_set` when an intake task joins a project and takes that project's next number; each scope draws from `task_number_counters`, so a moved or deleted task's number stays spent. The web renders it through `taskRef` (`web/src/lib/taskRef.ts`) — `#12` for a task, `AUTO-3` for an automation — never the raw id, and lists make it a link via `TaskRefLink`.
- **An agent's model is pinned per agent, passed by the daemon.** `modelPolicy` is `{}` (the runtime's default) or `{ "model": "<id>" }`, and the database store materializes it as `agents.model` beside `agents.executor_kind` (NULL = default; written only by `_agent_row`, derived from the snapshot like every materialized field); `backend/relay/core/model_policy.py` is the one validation seam (shape only — catalogs are per runtime/provider, so it is not an allowlist), mirrored in `web/src/lib/agentModels.ts`. The options the create drawer and profile row offer come from the runtime itself, never a web-side table: the daemon asks each ready CLI (`relay-daemon/src/agent-models.ts` — Claude's `--help` aliases/`availableModels`, `codex debug models`, `pi --list-models`, Kimi's config aliases) and reports `agentModels` at registration; the registry keeps only policy-valid ids (`agent_models_state`), and the agent view resolves `availableModels` from its placements' nodes on read. Dispatch carries it as `agentModel` → `AgentState.agent_model`, and `commands.ts` `runtimeModel` lets it beat the env default (local nodes included). A daemon without the `agent-model` capability fails the run rather than silently running the default. `toolPolicy` stays rejected until it is enforceable.
- **Streamed output never rewrites the session snapshot.** Event types with no reducer that arrive at stream rate (`agent.output`, `agent.output.batch`, `agent.collaboration`) are listed in `SNAPSHOT_NEUTRAL_SESSION_EVENTS` (`backend/relay/persistence/session/reducer.py`); the database store appends them with a bare version bump. Never give one of them a reducer — move it out of the set first. Likewise keep `daemon_nodes.updated_at`/`last_seen_at` and `sessions.version` out of every index so those writes stay HOT, and add an index to a hot table (`tasks`, `sessions`, `daemon_nodes`) only for a query that reads it. Table sizes and inline blob bytes: `uv run --project backend relay storage-report`.
- **A wait names its thread and its question, and an answer names the question.** Every `waiting_for_human` park writes a `waitingRequest` wait record (`backend/relay/core/human_waits.py`): a `questionId`, a `kind` (`question` / `check` / `budget`), and for an agent's question its `inputQuestion`/`inputOptions`/`inputNotes`, plus `waitingSessionId`; `inputNotes` are the acceptance-gate reasons the question stood in front of. A check whose round filed no report at all — not refused, not failed, nothing else wrong — carries `unreported: true` (`DaemonNodeRegistry._round_unreported` in `daemon_registry/runs/completion.py`), and the web then points at the agent's last message instead of quoting the gate, because that message is where the agent said what it needs. Before that park, a required step that owed a report and filed none is rerun once in the same round with a reminder (`report_reminder_transition` in `backend/relay/collaboration/policy.py`, outside the repair budget; a refused verdict or an answer turn is never reminded), so the agent decides done, continue, or blocked itself; only a second silent turn reaches the person. A check or budget wait on a task also offers the person's own mark done (the decisions route's `mark_done`). A run's closeout derives its id from the run request (`question_id_for_run`) so a retried finalization writes the same wait; any other park gets a minted id (`ensure_wait_record`). The thread's `session.completed` carries only the question fields. Only `_complete_run_request` (or a parked continuation / unblock, which pass `statusReason` + `statusSessionId` + optional `statusRequest`) may park a task — a finished step sets `running`, so `waiting_for_human` always means a person is needed. Task responses carry the wait projected once as `awaiting` (`task_awaiting` in `backend/relay/collaboration/awaiting.py`); the web renders it (`web/src/lib/awaitingInput.ts`) and never re-derives a task's wait — only a thread with no task reads its own fields. A message with `questionId` is an answer: it resumes the task only while that is still the question its task waits on in this thread (`CollaborationConductor._assert_current_question` / `_awaiting_task`), and is refused 409 `question_superseded` otherwise; the web attaches the shown question's id to every `accomplish` reply sent while the prompt is up. A reply without an id keeps the thread rule; a `discuss` message (the prompt's status choice) never takes a task round and cannot carry an id, and a human-started round opens a fresh continuation budget. `acceptance_status` (`persistence/task/lifecycle.py`) is the one place `done` becomes `review`. The asked question is replayed to the answering run through `conversation.py`, because the daemon consumes the verdict file. A blocked verdict that carries a question parks the task even if the CLI then exits non-zero, and a verdict file the daemon refuses is reported (`roundResultRejected`) and named on the task. Decisions (`/threads/{id}/decisions`) record `actorUserId` — only a login session or the browser-minted UI token can make one, never the node token an agent can reach; `mark_done` is the human's acceptance, so it closes a human-acceptance task as `done`. The verdict limits and `BLOCKED_ROUND_PREAMBLE` are pinned across daemon, backend, and web by `backend/tests/unit/test_round_result_parity.py`. Plan: `docs/hitl-improvement-plan.md`.
- **A runtime permission prompt pauses a live run; only a person answers it.** One runtime-agnostic broker, one adapter per runtime. Each `AGENT_REGISTRY` entry declares `permissionPrompts` — `{ kind: "adapter", adapter }` (`claude-mcp`: Claude's `--permission-prompt-tool` backed by a stdio MCP server; `codex-app-server`: Codex driven over `codex app-server`, because `codex exec` forces approvals off; `kimi-acp`: Kimi driven over `kimi acp`, because `kimi -p` auto-approves; `pi-extension`: a Pi extension whose blocking `tool_call` hook gives Pi, which has no permission system of its own, the posture Claude's default has — every command and edit asks, reads pass) or `{ kind: "none" }` for a runtime that cannot ask. On a `none`-mode computer with the `native` local permission policy, the daemon starts a per-run broker (`relay-daemon/src/permission-broker.ts`: private socket, backend post/poll — no runtime knowledge) and hands the run one launch (`AgentState.permission_prompt`, resolved by `permission-adapters/index.ts`); BoxLite and `trusted` runs bypass permissions and keep their usual commands. Adapters (`relay-daemon/src/permission-adapters/`) only translate a native request into the normalized `PermissionQuestion` (`protocol.ts`, `askBroker`) and the answer back, approving once and never "always"; a bridged runtime must re-emit exactly the stdout its plain CLI prints, so renderers, token usage, and resume stay untouched. Adding a runtime is a registry entry plus an adapter. Each prompt is a `run.permission_requested` daemon event the backend records as `agent.permission_requested`; `backend/relay/core/permission_requests.py` is the one reducer seam (`permissionRequests` open, a bounded `permissionDecisions` history), mirrored in relay-core's `session-store.ts` and `web/src/lib/permissionRequests.ts`. A person answers through `POST /threads/{id}/permission-requests/{requestId}` (the decisions route's actor rule — never the node token), and the daemon polls `GET /daemon-nodes/{id}/permission-requests/{requestId}` — answered only to the computer whose run asked — rather than receiving a command, so no command lease is involved. A prompt closes once: allow, deny (with an optional note, offered only where the runtime carries it to the agent — Claude's denial message and Pi's block reason; Codex's decline and Kimi's reject carry no text), or `expired` when its run completes, fails, or is cancelled first; adapters deny on abort or on any refusal they cannot retry, so an older backend yields a denial. A thread with an open prompt counts as needing its person (`threadAwaitsHuman`), and no task status changes while it waits.
- **Onboarding progress is derived; only choices are stored.** The wizard's steps (Computer connected with a ready runtime → Agent available → a completed run) are computed by `onboardingProgress` in `web/src/lib/onboarding.ts` from the nodes, agents, and threads the app already loads — never persisted. The Account's `onboarding` preference (`introSeenAt`, `dismissedAt`, `closedCards`) holds only what the person chose; clients send intents through `PATCH /auth/preferences` and the server stamps them (`backend/relay/security/onboarding.py`). Migration `20261016_0098` dismisses the wizard for every pre-existing account. Design: `docs/onboarding-wizard-design.md`.
- **Notifications carry facts and are written once.** `backend/relay/notifications/rules.py` is the one seam that decides which changes notify and whom; rows hold ids, names, and statuses, never prose, so the web renders them in the reader's language (`web/src/lib/notifications.ts`). A task notice is inserted inside the task store's write transaction (`insert_notification_rows` beside the automation outbox, but not gated by `emit_automation_events`): entering `review`, or `done` from anything but `review` — a person accepting a reviewed task gets no notice of their own click — for the owner and human assignee, minus whoever made that status change themself (`actorUserId` on the `task.status` event); a routine occurrence notifies only on `review`. Computer liveness is derived on read, so `ComputerNotificationWatcher` (`backend/relay/notifications/watcher.py`) observes every registered computer on an interval and announces a transition only by winning a compare-and-set on `notification_watch_state`, which is what lets every replica run it. A first sighting records liveness quietly but announces an Outdated Client; going offline is announced only after the computer stays offline for `OFFLINE_CONFIRM_SECONDS` in this process, so a blip or a backend restart (every heartbeat stale until daemons reconnect) stays quiet. The outdated state records the missing capabilities and clears only when the computer advertises them, so mixed-version replicas in a rolling deploy cannot flip it and repeat the notice. "Outdated" is capability-based (`backend/relay/core/daemon_capabilities.py`, which also holds the capability vocabulary) because every package still reports version 0.1.0: a registered computer missing any of `DAEMON_NODE_CAPABILITIES` is outdated, so a capability a daemon advertises only in some modes must never join that set — `test_client_version_parity.py` pins the backend set to the protocol type and to what the daemon sends. Muting a kind (`notification_preferences`) filters on read; it never deletes. `user_id` is text without a foreign key so an unknown owner id never fails a task write.
- **A runtime's status says why it cannot take work.** The daemon's readiness check reports each executor as `ready`, `failed` (installed but could not connect — not signed in, bad key, provider unreachable), `unavailable` (not installed: `AgentNotInstalledError`), or `unresponsive` (the check outlived its deadline: `AgentUnresponsiveError`, `runBoundedPreflight` in `relay-daemon/src/agent-preflight.ts`); a node record reads `unknown` for a runtime that never reported. The vocabulary is `DaemonAgentHealthStatus` in relay-core, mirrored by `backend/relay/core/runtime_status.py` (which also words the `executor_not_ready` reason), and rendered by `runtimeStatusLabel` / `agentStatusTone` (`web/src/lib/adminHelpers.ts`): not installed is a fact about the computer, so it stays neutral and hides opt-in Pi; only `failed` is red. A stopped computer is never a runtime status — liveness is derived on read, and the web says Offline over a dark computer's last `ready` or `unresponsive`. Only `ready` dispatches.
- **`ensureAgentReady` is silent on success.** Preflight failures throw; do not re-add success narration.
- **Never print raw JSONL.** Rendering is block-based: one `●` marker per agent turn, `○` + dim italic for thinking/reasoning, `⏺` for tool/command lines.
- **Automations are routines on the wire.** The product says Automations (`/automations`, every label), but tasks, events, columns, and API fields keep `routine*` names, like `daemon-node`. `routineTrigger` (schedule, task_event, run_event, webhook, manual) says what fires one; event and webhook firings flow through the transactional `automation_outbox` and `relay/automations/matcher.py`, never through a second dispatch path. v2 fields are `routineTriggers` (0..5, OR-ed), `routineState`, and `routineNextRunAt`; `backend/relay/automations/` is the one seam (`model`, `schedule`, `clock`, `matcher`, `firing`, `service`). Every trigger fires through `automation_state` pending, and the clock — never the reducer — computes next runs, because only it may resolve the server timezone. Legacy `routineCadence`/`routineEnabled`/… events still replay through `upgrade_legacy`; the API rejects them on write.

## Data Layout

Accounts, users, departments, login sessions, session/task events,
snapshots, artifacts, links, token usage, the daemon registry (nodes, commands,
runs, run requests), agents, teams, placements, and chat integrations live in
the configured database. The daemon host's private
state directory (never mounted into an agent sandbox) holds tokens/logs:

```text
~/.relay/daemon-nodes/<sandboxId>/credentials/<user>.token         # daemon auth token
~/.relay/daemon-nodes/<sandboxId>/logs/*.jsonl                         # daemon structured logs
```

Retired file-backed state under `.relay/` is no longer read or imported.
Installations must migrate that state with an earlier release before upgrading.
`RELAY_STORAGE`, `RELAY_AUTH_STORE`, `RELAY_DAEMON_STORE`, and
`RELAY_CHAT_STORE` are retired and only log a warning when set.

Only the active thread's host directory mounts into the BoxLite guest at
`/workspace` (`GUEST_WORKSPACE`). The guest `agent` user's UID/GID is aligned
to the host owner so file ownership stays sane.

## Verification

For behavior changes, add or update focused tests and run `npm test`.

Before handing off, check:

1. TypeScript compiles.
2. Existing backend, handoff, provider, daemon, supervisor, and web tests pass.
3. Terminal rendering tests still prove Claude/Codex JSONL is not printed raw.
4. Pi command generation remains compatible with old and new Pi CLI versions.

Test focus:

- `packages/relay-core/tests/handoff.test.ts`: prompt construction, stream
  rendering, and regression guards — must continue to prove no raw JSONL leaks
  through and that review prompts/commands omit verdict markers and feedback
  injection.
- `packages/relay-daemon/tests/daemon.test.ts`: daemon registration, command
  polling, and agent execution.
- `backend/tests/`: Python controller, event store behavior, HTTP API,
  backend and daemon registry (auth, persistence, revival, cancellation), task
  scheduler/routine promotion, dashboard endpoints, and session token usage.
- `web/tests/status.test.ts`: web daemon-node status derivation and local-node
  claiming behavior.
- `web/tests/agentStream.test.ts`, `web/tests/messageBlock.test.ts`,
  `web/tests/tokenUsage.test.ts`, `web/tests/manageAgents.test.ts`,
  `web/tests/workspaceHome.test.ts`: web component and utility unit tests.

Tests use Node's built-in `node:test` runner with `describe`/`it`; a vitest
pass over the same files surfaces a spurious "No test suite found" line but
real assertions are reported correctly under either runner.
