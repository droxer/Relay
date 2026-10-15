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
  by default.
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
- Completed-run agent log tail cap: `RELAY_AGENT_RESULT_LOG_LIMIT` (default
  `262144` chars) — the fallback transcript keeps the head of long output.
- Daemon terminal echo of rendered agent output:
  `RELAY_DAEMON_ECHO_AGENT_OUTPUT` (default on). The supervisor sets it to `0`
  for every daemon it launches so supervisor logs stay lifecycle-only; output
  still streams to the backend and the daemon's JSONL run logs.
- Stop backend, daemon, and BoxLite processes: `make stop`.
- Deploy to Railway behind Cloudflare, with the web UI as a Cloudflare Worker:
  `deploy/deploy.sh up` (config in git-ignored `deploy/.env`; see
  `deploy/README.md`). Test it against mock APIs with `deploy/tests/run.sh`.
- Install pre-commit hooks: `make pre-commit-install`.
- Run pre-commit hooks on all files: `make pre-commit-run`.
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
  - `backend/relay/app.py` — FastAPI HTTP/SSE backend (canonical JSON API
    under `/api/v1`, persisted media under `/profile-images/`, and the exported
    web UI at `/`; unversioned routes such as `/cp` are not mounted), backed by
    the configured database plus the remaining operational state under
    `.relay/`.
  - `backend/relay/api/` — HTTP routes split by domain: `admin_routes.py`
    (users, departments, user edits, org settings, node assignment, agent
    management, dashboard data — KPI tiles, fleet health, activity feed, token
    usage), `auth_routes.py`, `chat_routes.py`, `daemon_node_routes.py`,
    `sandbox_routes.py`, `session_routes.py`, `task_routes.py`,
    `web_routes.py`, plus newer domain modules `agent_routes.py`,
    `collaboration_routes.py`, `managed_node_routes.py`,
    `node_workspace_routes.py`, `profile_image_routes.py`, `project_routes.py`,
    and `team_routes.py`.
  - `backend/relay/core/` — shared models, environment loading, ids, logging,
    and storage config.
  - `backend/relay/persistence/` — event-sourced stores: `session_store.py`,
    `task_store.py`, `daemon_store.py`, `agent_store.py`,
    `user_agent_store.py`, `agent_placement_store.py`, `team_store.py`,
    `project_store.py`, `org_settings_store.py`, `profile_image_store.py`, and
    shared helpers in `store_common.py`/`protocols.py`/`schema.py`.
  - `backend/relay/security/` — `auth.py` (auth store and JWT helpers) and
    `rate_limit.py`.
  - `backend/relay/sessions/` — `controller.py` (session mutation),
    `bridge.py`/`conversation.py`/`handoff.py` (continuity and handoff).
  - `backend/relay/daemon_registry/` — `registry.py`, `node_backend.py`
    (daemon admission and run dispatch), `scheduling.py`, `artifacts.py`,
    `credentials.py`.
  - `backend/relay/collaboration/` — `service.py` (`CollaborationConductor`:
    turns a message, recovery, or legacy run into one round manifest),
    `styles.py` (team styles and slot filling), and the pure round policy in
    `work.py` (work-report acceptance, findings repair, consultations, lead
    plans) and `policy.py` (`next_work_transition`, runtime-failure repair).
    The daemon registry applies these transitions; it should not decide them.
  - `backend/relay/tasks/scheduler.py` — background scheduler that promotes
    due routines and dispatches assigned tasks to ready daemon nodes.
  - `backend/relay/automations/` — automation triggers, schedule, clock,
    matcher, and firing (see the Automations invariant).
  - `backend/relay/chat/integrations.py` — chat provider integration glue.
  - `backend/relay/services/` — narrower runtime services: `agent_binding.py`,
    `agent_creation.py`, `agent_routing.py`, `computer_limits.py`,
    `managed_nodes.py`, `task_dispatch.py`, `task_rounds.py`,
    `team_dispatch.py`, `team_membership.py`, `workspace_query.py`, and
    related helpers.
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
  executor management (`ManageExecutorsDrawer`).

### Backend / daemon / client token contract

- The per-user token lives at `~/.relay/daemon-nodes/<sandboxId>/credentials/<user>.token` on the daemon's host (created by whichever side starts first via `ensureDaemonNodeToken`); this directory must never be mounted into an agent sandbox. A one-time migration reads and deletes any token found at the legacy `<workspace>/.relay/daemon-nodes/<user>.token` path. `RELAY_DAEMON_TOKEN` overrides it (`RELAY_DAEMON_NODE_TOKEN` is the accepted legacy name). The backend stores only a SHA-256 hash; a fresh provision or explicit reissue returns the plaintext once. The legacy reveal route answers 409. Browser device setup issues the runtime credential at single-use redemption. Migration 0089 clears legacy database secrets, and the file store erases legacy node secrets on startup.
- Re-registering a sandbox with a different token is rejected (401) — registration cannot rotate or hijack tokens. The daemon exits successfully on 401/410, asking the owner to run setup again after credential rejection. New nodes require enrollment or authenticated admin registration.
- An authorized command poll revives a `stopped`/`failed` daemon record to `ready` (covers backend restarts); provisioning by user prefers the live daemon over offline placeholders.
- Deleting a non-managed node leaves a tombstone (`status: "deleted"` + `retiredAt`) instead of dropping the row — `registry.retire_deleted`. Registrations, polls, heartbeats, and events from a deleted node answer `410`, matched by node id and by workspace identity so a daemon restart cannot resurrect it; the daemon shuts down on `410`. Re-enrolling the machine works because provisioning a fresh record gives registration a live row to land on.
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

- **The backend never executes agents.** All agent execution flows through daemon commands (`ServerDaemonNodeBackend.run` → registry queue → daemon poll). Do not reintroduce in-process execution paths into the Python backend. The background `TaskScheduler` (`backend/relay/tasks/scheduler.py`) only promotes due routines and dispatches already-assigned tasks through the same daemon path; disable it with `RELAY_TASK_SCHEDULER_ENABLED=0` when needed.
- **Never mock or seed data in the server.** It reads the configured database and real operational state under `.relay/`.
- **A delivered execution reservation releases only on daemon exit evidence or a recorded human assertion.** The assertion paths are the reconcile endpoint (`POST /threads/{id}/execution/reconcile`) and thread deletion itself once the execution requires recovery (`canReportGone`); both append `session.execution_reconciled` with the actor, so the log never reads as observed exit. A dead computer's run becomes reportable (`execution_lost`, `execution_interrupted`, or a stop past its grace) but never self-releases. Every overdue deletion must have a way out — a person's action or automatic progress; `backend/tests/unit/test_execution_escape.py` sweeps the execution-status inputs to enforce it, so extend its axes with any new phase, status, or recovery reason.
- **A personal computer is bounded; admin hardware is not.** How many `nodeLocation: "user-device"` computers a user may enroll comes from `users.max_local_computers` when one is pinned, and the single-row `org_settings` table otherwise (`backend/relay/persistence/org_settings_store.py`, default 3, range 0–50). `backend/relay/services/computer_limits.py` is the one seam that resolves and enforces it; call `assert_local_computer_allowed` only where a computer would actually be created (self-enrollment and the admin create route), never on adoption of a workspace the user already enrolled — a user at their limit must still be able to re-enroll a machine they have. Enforcement is creation-only: lowering a limit never disconnects an existing computer. The override lives on the users table, so it (and `PATCH /admin/users/{id}`) needs the database auth store; `GET /admin/settings` reports `capabilities.userEdits` so the web UI can omit those controls under the file store.
- **"Employee" is the pre-rename name of User; Account is the login.** Migration `20261015_0094` renamed `employees` → `users`, `auth_users` → `auth_accounts`, and every `*employee*` column, index, and constraint (generated names included); `20261015_0095` rewrites the JSON keys in event payloads and snapshots in committed, resumable batches, and its downgrade maps back exactly `LEGACY_KEYS`. State that never passes through it — file-backed stores (`store_common._read_json`/`_read_jsonl`), auth file-store sessions, and bodies on `/daemon-node*`, `/computer-authorizations`, `/admin/daemon-nodes`, and `/admin/managed-nodes` routes — is upgraded on read by `backend/relay/core/legacy_names.py`; the daemon side is `relay-daemon/src/legacy-names.ts` (`--employee-id`, `RELAY_EMPLOYEE_ID`, installed-service argv). Responses an older daemon reads (`/computer-authorizations/token`, `/daemon-node-enrollments`) still echo `employeeId`. Two `employee` strings stay on purpose: handle-derived ids hash under `USER_ENTITY_KIND = "employee"` (`security/auth.py`), and the password blocklist. Older supervisors keep working through the deprecated `GET /admin/employees`, `employeeId` mirrored onto `/admin/daemon-nodes` records (`with_legacy_user_id`), and body upgrades on `/admin/daemon-nodes` and `/admin/managed-nodes`; drop these once every supervisor is upgraded. Never write a new `employee` name.
- **A user's id is a key; their handle is the name.** Under the database auth store `users.id` is a UUID (uuid5 of the handle for anything created through the admin form) and stays the foreign key everywhere; `users.handle` is the unique `@name` every admin surface renders. Resolve a handle through `auth_store.resolve_user_id` (it consults the handle column before the uuid5 mapping, because backfilled rows have an id that is not uuid5 of their handle), and never render `user.id` as a handle — the web helpers `userHandleOf` / `handleForUserId` in `web/src/lib/userHandle.ts` are the one seam, and they never fall back to the raw UUID. Handles are validated on both sides by `normalize_user_handle` (`backend/relay/api/helpers.py`) and its mirror in the same web module. `POST /admin/users` rejects a handle that already belongs to a live user (409) rather than letting `ensure_user` reuse and overwrite that row. The backfill rule for migration `20260831_0065` lives in `backend/relay/persistence/user_handle_backfill.py` so the migration and `relay rehearse-user-handles` (read-only; run it against a copy of production first) cannot disagree.
- **One password policy, in `backend/relay/security/passwords.py`.** Length plus a blocklist, context words (the account's own username/handle/name/email), and degenerate shapes — no composition rules, per NIST SP 800-63B. Both stores' `create_user` call `validate_password`, and both `bootstrap_with_token` paths delegate to `create_user`, so no path sets a password without it; pass the account's `identifiers` at every call site. `web/src/lib/passwordPolicy.ts` mirrors every rule except the blocklist — that one stays server-side deliberately, since a few hundred entries duplicated in two languages would drift.
- **Sessions and tasks carry an owner.** `RelaySession.ownerUserId` / `RelayTask.ownerUserId` (set from the `session.created` / `task.created` events) attribute work to the user whose agent runs it; `HumanDecision.actorUserId` records who approved/rejected/handed off. `ServerDaemonNodeBackend.run` threads the sandbox's `userId` into the owner, and `assertSessionOwnedByUser` is the authorization seam — a user's agent may only act on sessions its user owns (ownerless legacy sessions are allowed). This is where the future task-scope / tool-policy / approval checks belong; keep it the single checkpoint rather than scattering ownership checks.
- **A thread action speaks only for the task it is executing.** Sessions carry no `taskId`, and task links are history, never execution authority. Stop, cancel, mark-done, reconcile, and delete resolve the task through `thread_task_scope` (`backend/relay/sessions/task_scope.py`) — the active run request's `taskId`, else the active round's task `workScope` while that task is in flight — and resolve it *before* cancelling, because an undelivered request stops being active and an `assigned` task left behind is re-dispatched by the scheduler. Task rounds retain their original `taskExecutionOwner`; never borrow the task's current claim for an old round. Older rounds need a matching retained run request to establish ownership. Completion retries repair missing task writes under the original claim without duplicating the session event. A finished agent turn writes no task status; the round's closeout picks it, so status-change automations never see a phantom `waiting_for_human`. A round that stopped to ask closes its thread `completed` with `workOutcome: "blocked"`; count that as waiting through `session_awaits_human` / `isAwaitingHuman` (`web/src/lib/workflow.ts`), never `status` alone.
- **Event log is authoritative.** All session/task state changes go through the Python `SessionStore.append_event` / `TaskStore.append_event`. Database snapshots and materialized fields are derived. Never mutate snapshot fields directly outside the store's replay.
- **Immutability.** Session/task mutations return new objects (`mergeAgentState`, spread updates). Existing pattern; preserve it.
- **Pi CLI version skew.** Pi versions differ — use `-P` only when `pi --help` advertises `-P`/`--print-streaming`, otherwise `-p`. `commands.ts` already handles this; keep both paths working.
- **Agent identity is registry-driven.** Four agents are recognized: `claude`, `pi`, `codex`, `kimi` (`AgentName` in `relay-core/src/state.ts`). The single source of truth is `AGENT_REGISTRY` in `relay-core/src/agents.ts` — command builder, renderer, preflight, failure budget, capabilities (only `codex` has `review`), role, and guest-auth flag. Dispatch sites use `getAgent`/`AGENT_NAMES`/`isAgentName` instead of literal switches, and per-agent failure counts live in `AgentState.agent_failures` (use `failureCount`/`withFailure`). Adding an agent = one `AGENT_REGISTRY` entry plus its CLI specifics: a command builder in `commands.ts`, a prompt in `prompts.ts`, any guest-auth file writes in the daemon (`relay-daemon/src/index.ts` `ensureHostAgentReady` + `box.ts`), and — because the web app cannot import the node-only registry — mirror the agent in `App.tsx`/`MessageBlock.tsx` literals and the `agent.<name>` i18n keys (the `Record<AgentName, …>` types enforce this). Extra agents are invoked through explicit assignment, while web chat uses the composer agent picker. Kimi's CLI flags in `buildKimiActionCommand` are provisional — confirm against the installed Kimi CLI. Each agent supports two task modes — `action` (do the work) and `review` (`AgentTaskMode` in `relay-core/src/state.ts`).
- **A turn belongs to a logical agent, not an executor kind.** Several named agents can share one `executorKind`, so `AgentName` never identifies who ran a turn. The dispatched agent id is persisted as `logicalAgentId` on the `agent.started` event and on `RelaySession.agentRuns`; web surfaces resolve names and re-dispatch (`labelForAgentRun` in `web/src/lib/agentDisplayNames.ts`, `DerivedMessage.agentId`, retry/rerun lookups) from that id, falling back to the per-executor name map only for legacy runs that carry none. Never label or route a chat turn by executor kind alone.
- **Token usage flows through `normalizeTokenUsage`.** All agent CLI output formats (Claude, Codex, Pi, Kimi) must be normalized through `normalizeTokenUsage` in `relay-core/src/token-usage.ts` before storing on the session. Cache is split into `cacheRead` and `cacheWrite` (`cache` stays their sum; a legacy record's combined `cache` counts as reads — `splitCache`). Every headline — the thread turn badge and the dashboard KPI/bars — shows `freshTokens` (input + output + cache writes), never `total`, because cache reads dominate a long run while costing a tenth of input. The backend stores per-session totals and a per-run ledger (`session_run_token_usage`) that also holds a zero `reported = false` row for a run that *completed* without counts, so the dashboard (`GET /api/v1/admin/dashboard/tokens?tz=<IANA>`, days bucketed in the viewer's zone) names unmeasured runtimes from data rather than a hardcoded list. Cancelled and failed runs carry whatever usage the process reported.
- **Generated workspace artifacts are daemon-reported.** The daemon diffs document-type workspace files around each successful run (`relay-daemon/src/generated-files.ts`) and reports them in `run.completed` (`generatedFiles`, with inline base64 content for small files), advertising the `generated-files` capability at registration. The backend indexes them as `workspace_file` artifacts via `SessionStore.index_workspace_artifact`, keeping a content snapshot so downloads survive workspace rewrites/deletes. A daemon that reports nothing indexes nothing: there is no backend-side filesystem walk, so the backend never needs to share a filesystem with a daemon. A daemon without the `produced-files` capability reports only document types and is indexed under the older, narrower rule. A re-generated file gets a new artifact attributed to the producing run; `workspace_artifacts` (shared in `api/helpers.py`) dedupes the index to the newest record per file, and `GET /api/v1/tasks/{id}/artifacts` rolls artifacts up to the task by aggregating its linked sessions with the same newest-per-file dedupe. Keep the extension allowlist free of ambiguous types (no `.key`).
- **Agent home workspace.** An agent's files live in its home (`agents/agent-<b64>/` under the node mount) while a run is active, but agent-home directories are not browsed through daemon `workspace.list`/`workspace.read` commands anymore. Live workspace reads use the shared node/project root and the `workspace-read-shared` capability; generated file snapshots remain the durable record for offline browsing.
- **A task's workspace is derived, not stored.** A backlog task's rounds share `tasks/<taskId>/` under the node root, and a routine occurrence nests at `tasks/<sourceRoutineId>/<taskId>/` so a routine's runs are isolated but browsable together. `backend/relay/services/task_workspace.py` is the one seam that resolves it — never rebuild the path at a call site. A task dispatched into a project keeps the project workspace; the project always wins. The layout is chosen at dispatch against the already-chosen node, so a daemon without the `task-workspaces` capability degrades to the per-thread directory instead of failing the run (a project *is* its workspace, so its gate stays fatal). Because rounds now share a directory, the daemon's `workspaceRunGate` must key on the task workspace or concurrent rounds overwrite each other.
- **The waitlist is off by default and is not sign-up.** `RELAY_WAITLIST_ENABLED=1` mounts `/waitlist*` and `/admin/waitlist*` (`is_waitlist_route` in `backend/relay/api/contract.py`); the web learns it at runtime from `GET /auth/status` → `waitlistEnabled`, so there is no build flag. `deploy/deploy.sh` sets it to `1` for the hosted Railway deploy unless `deploy/.env` says `0`; the backend default stays off for every other install. `backend/relay/services/waitlist.py` is the one seam for transitions; `persistence/waitlist_store.py` is a plain row store (not an event log) whose conditional updates make an invite single-use — `claim_invite` before creating the account, `release_claim` if that fails. Public answers stay uniform: every valid join is `202` (new, known, declined, honeypot) and every dead token one `404`; the confirmation email is sent in a background task so its latency cannot reveal a new address. Invite tokens ride the URL fragment and POST bodies (`/waitlist/invites/lookup`, `/accept`) — never a path, so no access log keeps one — and only their hash is stored; batch invites return their links before sending (`queued`). Email goes through `backend/relay/notifications/mailer.py` (`CloudflareMailer` via the Cloudflare Email Service REST API, else `NullMailer`); a send never raises or changes an entry's status, and a partial `RELAY_MAIL_*` set fails startup. Plan: `docs/waitlist-design.md`.
- **Chat channels are off by default.** `RELAY_CHANNELS_ENABLED=1` is what mounts the chat routes (`/admin/chat-integrations`, `/internal/chat/*`) — `is_channel_route` in `backend/relay/api/contract.py` is the one seam that classifies them — and `NEXT_PUBLIC_RELAY_CHANNELS_ENABLED=1` (`web/src/lib/features.ts`) is what gives the web build its `/channels` route, palette command, and `G H` chord. Both must be set together. The chat store is still built and tested (the `relay-chat` gateway package was removed); a new chat route must sit under one of those two prefixes or it escapes the switch.
- **Assignment follows the computer, not the roster.** Anyone who shares a computer shares its workspace, so work there may go to any agent on it or any team whose whole roster is placed on it. A project task may name a non-member agent or a team on the project's computer (`project_task_assignment_error` in `backend/relay/services/project_runtime.py` is the one admission rule; a member the project *disabled* stays refused), and it still runs in the project workspace, and its thread stays the project's room — the team never becomes the thread's team. A started thread may address a team on its computer (`addressTeamId`) or, in a team thread, an agent outside the team (`CollaborationConductor._round_team_id`); the thread keeps its own team, and recovery plus the legacy `/agent-runs` path keep the strict roster. A project thread is the exception: it stays the project's room, so addressing a team there is refused (`project_team_conflict`) — route team work into a project through a task instead. The web mirrors the rule in `agentOnComputer` / `teamOnComputer` / `teamSharesOneComputer` (`web/src/lib/taskAssignment.ts`) and `threadRoundTeam` (`web/src/lib/messageRouting.ts`). Team setup enforces the same shape up front: a team picks its computer first and records `computerId`, and every member must be placed there (`backend/relay/services/team_computer.py` is the one seam; the web mirror is `web/src/lib/teamComputer.ts`) — the same rule a project's crew already follows through `validate_project_roster`.
- **A project's brief reaches every run; agents propose, owners apply.** `goal`/`context` ride the round's pinned project snapshot, and the backend renders them with the enabled crew into the `[Project]` prompt section (`project_context_brief` in `backend/relay/services/project_context.py`); the daemon mirrors it to `.relay/PROJECT.md`. Agent-drafted setup (`backend/relay/services/project_setup.py`, `POST /projects/{id}/setup`) is an ordinary daemon run whose drafter is admitted by the project-task rule, not roster membership; its proposal (`.relay/project-setup-<runId>.json`, reported as `projectSetup` behind the `project-setup` capability) is only stored — applying it is the normal project PATCH plus `setupResolution`, so roster rules run when it takes effect. Round-result `contextSuggestions` likewise wait on the project until the owner adopts or dismisses them (`resolveContextSuggestions`); nothing an agent writes changes the brief by itself. See ADR-022.
- **A task's number is per scope and never reused.** A project counts its tasks, a user counts their other tasks, and separately their automations (`task_number_scope` in `backend/relay/persistence/task_numbering.py` is the one seam). The number rides on `task.created`, or on `task.project_set` when an intake task joins a project and takes that project's next number; each scope draws from `task_number_counters`, so a moved or deleted task's number stays spent. The web renders it through `taskRef` (`web/src/lib/taskRef.ts`) — `#12` for a task, `AUTO-3` for an automation — never the raw id, and lists make it a link via `TaskRefLink`.
- **An agent's model is pinned per agent, passed by the daemon.** `modelPolicy` is `{}` (the runtime's default) or `{ "model": "<id>" }`, and the database store materializes it as `agents.model` beside `agents.executor_kind` (NULL = default; written only by `_agent_row`, derived from the snapshot like every materialized field); `backend/relay/core/model_policy.py` is the one validation seam (shape only — catalogs are per runtime/provider, so it is not an allowlist), mirrored in `web/src/lib/agentModels.ts`. The options the create drawer and profile row offer come from the runtime itself, never a web-side table: the daemon asks each ready CLI (`relay-daemon/src/agent-models.ts` — Claude's `--help` aliases/`availableModels`, `codex debug models`, `pi --list-models`, Kimi's config aliases) and reports `agentModels` at registration; the registry keeps only policy-valid ids (`agent_models_state`), and the agent view resolves `availableModels` from its placements' nodes on read. Dispatch carries it as `agentModel` → `AgentState.agent_model`, and `commands.ts` `runtimeModel` lets it beat the env default (local nodes included). A daemon without the `agent-model` capability fails the run rather than silently running the default. `toolPolicy` stays rejected until it is enforceable.
- **Streamed output never rewrites the session snapshot.** Event types with no reducer that arrive at stream rate (`agent.output`, `agent.output.batch`, `agent.collaboration`) are listed in `SNAPSHOT_NEUTRAL_SESSION_EVENTS` (`backend/relay/persistence/store_common.py`); the database store appends them with a bare version bump. Never give one of them a reducer — move it out of the set first. Likewise keep `daemon_nodes.updated_at`/`last_seen_at` and `sessions.version` out of every index so those writes stay HOT, and add an index to a hot table (`tasks`, `sessions`, `daemon_nodes`) only for a query that reads it. Table sizes and inline blob bytes: `uv run --project backend relay storage-report`.
- **A wait names its thread, and its question is structured.** A blocked round's verdict (`note`, `options`) becomes `inputQuestion`/`inputOptions`/`inputNotes` on `session.completed` and `waitingRequest` + `waitingSessionId` on the task's `waiting_for_human` status; `inputNotes` are the acceptance-gate reasons the question stood in front of. Only `_complete_run_request` (or a parked continuation / unblock, which pass `statusReason` + `statusSessionId`) may park a task — a finished step sets `running`, so `waiting_for_human` always means a person is needed. A reply resumes the task only from the thread it waits in (`CollaborationConductor._awaiting_task`, mirrored by `awaitingInput` in `web/src/lib/awaitingInput.ts`); a `discuss` message (the prompt's status choice) never takes a task round, and a human-started round opens a fresh continuation budget. The asked question is replayed to the answering run through `conversation.py`, because the daemon consumes the verdict file. A blocked verdict that carries a question parks the task even if the CLI then exits non-zero, and a verdict file the daemon refuses is reported (`roundResultRejected`) and named on the task. Decisions (`/threads/{id}/decisions`) record `actorUserId` — only a login session or the browser-minted UI token can make one, never the node token an agent can reach; `mark_done` is the human's acceptance, so it closes a human-acceptance task as `done`. The verdict limits and `BLOCKED_ROUND_PREAMBLE` are pinned across daemon, backend, and web by `backend/tests/unit/test_round_result_parity.py`. Plan: `docs/hitl-improvement-plan.md`.
- **`ensureAgentReady` is silent on success.** Preflight failures throw; do not re-add success narration.
- **Never print raw JSONL.** Rendering is block-based: one `●` marker per agent turn, `○` + dim italic for thinking/reasoning, `⏺` for tool/command lines.
- **Automations are routines on the wire.** The product says Automations (`/automations`, every label), but tasks, events, columns, and API fields keep `routine*` names, like `daemon-node`. `routineTrigger` (schedule, task_event, run_event, webhook, manual) says what fires one; event and webhook firings flow through the transactional `automation_outbox` and `relay/automations/matcher.py`, never through a second dispatch path. v2 fields are `routineTriggers` (0..5, OR-ed), `routineState`, and `routineNextRunAt`; `backend/relay/automations/` is the one seam (`model`, `schedule`, `clock`, `matcher`, `firing`, `service`). Every trigger fires through `automation_state` pending, and the clock — never the reducer — computes next runs, because only it may resolve the server timezone. Legacy `routineCadence`/`routineEnabled`/… events still replay through `upgrade_legacy`; the API rejects them on write.

## Data Layout

Session/task events, snapshots, artifacts, links, and token usage live in the
configured database. Remaining operational state lives under `.relay/` (repo
root by default — `DEFAULT_RELAY_DATA_DIR` — for the daemon registry) and under
the daemon host's private state directory (never mounted into an agent
sandbox) for tokens/logs:

```text
.relay/daemon/{nodes,commands,runs,run-requests,events}/               # persisted daemon registry state
~/.relay/daemon-nodes/<sandboxId>/credentials/<user>.token         # daemon auth token
~/.relay/daemon-nodes/<sandboxId>/logs/*.jsonl                         # daemon structured logs
```

Legacy `.relay/sessions/` and `.relay/tasks/` trees are migration inputs only;
the runtime does not use them as its session/task store.

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
