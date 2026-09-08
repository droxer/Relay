# Relay Agent Guide

This repository uses TypeScript/Node.js for the core protocol, daemon, and web
client. The host backend/control plane is now Python-first and lives at the
repository root in `backend/` with `pyproject.toml`; keep new backend runtime code in Python unless a
compatibility shim must remain in TypeScript during migration.

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
  `packages/relay-core/`, `packages/relay-chat/`, `packages/relay-daemon/`,
  `packages/relay-supervisor/`, and top-level web frontend `web/`.
- Backend CLI entrypoint: `backend/relay/cli.py`.
- Daemon CLI entrypoint: `packages/relay-daemon/src/cli.ts`.
- Shared protocol and agent runtime modules: `packages/relay-core/src/`.
- Chat gateway and provider adapters: `packages/relay-chat/src/`.
- Python backend implementation modules: `backend/relay/` — organized as
  `core/` (models, environment, ids, storage config), `persistence/` (event
  stores), `security/` (auth, rate limiting), `sessions/` (session mutation
  controller, continuity, handoff), `daemon_registry/` (registration,
  admission/dispatch, scheduling), `tasks/` (routine scheduler), `chat/`
  (provider integrations), and `services/` (narrower runtime services: agent
  binding/creation/routing, computer limits, managed nodes, task/team
  dispatch, workspace queries).
- Python backend HTTP routes: `backend/relay/api/` (split by domain —
  `admin_routes.py`, `auth_routes.py`, `chat_routes.py`,
  `daemon_node_routes.py`, `sandbox_routes.py`, `session_routes.py`,
  `task_routes.py`, `web_routes.py`, and newer domain modules
  `agent_routes.py`, `collaboration_routes.py`,
  `managed_node_routes.py`, `node_workspace_routes.py`,
  `profile_image_routes.py`, `project_routes.py`, `team_routes.py`).
- Tests: Python backend tests under `backend/tests/`, TypeScript package tests
  under `packages/*/tests/`, and web tests under `web/tests/`.
- Package manager: npm.
- Local devbox image: `dockerfile`.
- Generated outputs: `dist/`, `packages/*/dist/`, `web/out/`, `web/.next/`,
  `node_modules/`, `.oci/`, and `.relay/` directories at any workspace level.

Node.js 22.19 or newer is required.

## Commands

- Install dependencies: `npm install`.
- Build packages: `make build-packages` builds `relay-core`, `relay-daemon`, and `relay-supervisor` only. Full build: `npm run build` (includes `relay-chat` and `web`).
- Test: `npm test` or `make test`.
- Run one built test file: `node --test dist/packages/relay-core/tests/handoff.test.js`
  after a build.
- Run the web UI in dev mode (proxies API to the backend): `make web` (serves on `http://127.0.0.1:5000`).
- Run the API server on a second port: `make serve`; default port is `8787`, override
  with `PORT=9000`. Same full application as `make backend`; only the port
  default differs.
- Run database migrations: `make backend-migrate` (Alembic; optionally pass `DATABASE_URL=<url>`).
- Backend task scheduler env: `RELAY_TASK_SCHEDULER_ENABLED` (default on),
  `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS` (default `10`),
  `RELAY_TASK_SCHEDULER_MAX_DISPATCHES` (default `5`), and
  `RELAY_TASK_DISPATCH_MAX_FAILURES` (default `10`, consecutive classified
  dispatch failures before a task is blocked).
- Completed-run agent log tail cap: `RELAY_AGENT_RESULT_LOG_LIMIT` (default
  `262144` chars) — the fallback transcript keeps the head of long output.
- Stop Relay and BoxLite processes: `make stop`.
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
Codex, and Kimi CLIs inside it.

Key modules:

- `packages/relay-core/src/index.ts`: shared protocol, agent state, prompts,
  command builders, stream renderers, token-usage normalization, guest helpers,
  and agent execution units.
- `packages/relay-core/src/token-usage.ts`: `TokenUsage` type and
  `normalizeTokenUsage` — normalizes input/output/cache token counts from any
  agent CLI output format.
- `packages/relay-chat/src/gateway.ts`: `RelayChatGateway` — routes chat
  provider events to the backend and streams session updates back.
- `packages/relay-chat/src/providers/`: Discord, Telegram, and Lark
  conversation adapters.
- `backend/relay/cli.py`: Python backend binary entrypoint (`relay`).
- `packages/relay-daemon/src/cli.ts`: daemon binary entrypoint.
- `packages/relay-daemon/src/index.ts`: daemon runtime — registers with the
  backend, polls for commands, owns the sandbox, and runs agent CLIs.
- `packages/relay-daemon/src/sandbox-session.ts`: sandbox session lifecycle and
  agent readiness preflight (`ensureAgentReady`).
- `backend/relay/sessions/controller.py`: session mutation controller.
- `backend/relay/persistence/`: event-sourced session, task, daemon, agent,
  placement, team, and project stores (`session_store.py`, `task_store.py`,
  `daemon_store.py`, `agent_store.py`, `employee_agent_store.py`,
  `agent_placement_store.py`, `team_store.py`, `project_store.py`).
- `backend/relay/daemon_registry/node_backend.py`: daemon admission and
  backend run dispatch (with `registry.py` and `scheduling.py`).
- `backend/relay/tasks/scheduler.py`: background scheduler that
  promotes due routines and dispatches assigned tasks to ready daemon nodes.
  Controlled by `RELAY_TASK_SCHEDULER_ENABLED` (default on),
  `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS`, and
  `RELAY_TASK_SCHEDULER_MAX_DISPATCHES`.
- `backend/relay/security/auth.py`: auth store and JWT helpers.
- `backend/relay/api/admin_routes.py`: admin control-panel routes — users,
  departments, node assignment, agent management, and dashboard data
  (KPI tiles, fleet health, activity feed, token usage).
- `packages/relay-core/src/nodes.ts`: single-agent execution units. Each agent CLI runs in
  BoxLite through `execStream`.
- `packages/relay-core/src/commands.ts` and
  `packages/relay-core/src/prompts.ts`: shell argv and prompt construction for agents and modes.
- `packages/relay-daemon/src/box.ts`,
  `packages/relay-core/src/guest.ts`, and
  `packages/relay-core/src/env.ts`: BoxLite VM setup, guest auth provisioning, and env loading.
- `packages/relay-core/src/renderers.ts`: streaming JSONL to terminal text converters.
- `packages/relay-core/src/format.ts`: ANSI formatting helpers.
- `backend/relay/app.py`: FastAPI HTTP/SSE API backed by the configured database
  plus the remaining operational state under `.relay/`.

## Implementation Notes

- Use BoxLite's Node SDK (`@boxlite-ai/boxlite`) for VM lifecycle and command
  execution.
- `execStream()` should stream stdout/stderr while also collecting output for
  routing and logs.
- Claude uses `--output-format stream-json`; render JSONL through
  `JsonLineRenderer` instead of printing raw JSON.
- Codex uses `exec --json`; render JSONL through `JsonLineRenderer` instead of
  printing raw JSON.
- Pi versions differ: use `-P` only when `pi --help` advertises `-P` or
  `--print-streaming`; otherwise fall back to `-p`.
- Keep terminal output readable: section headers, status labels, aligned startup
  fields, and no raw JSON events.
- `ensureAgentReady` is silent on success. Preflight failures throw; do not
  re-add success narration.

## Invariants

- **The backend never executes agents.** All agent execution flows through
  daemon commands (`ServerDaemonNodeBackend.run` → registry queue → daemon
  poll). The background `TaskScheduler` only promotes due routines and
  dispatches already-assigned tasks; it does not bypass the daemon path.
- Event logs are authoritative. All session/task state changes go through the
  Python `SessionStore.append_event` or `TaskStore.append_event`; database
  snapshots and materialized fields are derived.
- Preserve immutable session/task updates through helpers such as
  `mergeAgentState` and object spreads.
- Agent names are currently `claude`, `pi`, `codex`, and `kimi`. Adding another agent
  requires validation, command, prompt, routing, and renderer changes.
- Never mock or seed data in the server; it reads the configured database and
  real operational state under `.relay/`.

## Data Layout

Session/task events, snapshots, artifacts, and links live in the configured
database. Remaining generated operational state lives under `.relay/`:

```text
.relay/daemon/{nodes,commands,runs,run-requests,events}/
~/.relay/daemon-nodes/<sandbox-id>/credentials/<employee-id>.token
~/.relay/daemon-nodes/<sandbox-id>/logs/*.jsonl
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

- `packages/relay-core/tests/handoff.test.ts`: prompt construction, stream rendering, and
  regression guards that review mode omits verdict markers and feedback injection.
- `packages/relay-chat/tests/chat.test.ts`: chat gateway, provider adapters,
  command parsing, and relay-client integration.
- `packages/relay-daemon/tests/daemon.test.ts`: daemon registration, command
  polling, and agent execution.
- `backend/tests/`: Python controller, event store behavior, daemon registry,
  task scheduler/routine promotion, and HTTP API tests.
- `web/tests/status.test.ts`: web daemon-node status derivation.
- `web/tests/agentStream.test.ts`, `web/tests/messageBlock.test.ts`,
  `web/tests/tokenUsage.test.ts`, `web/tests/manageAgents.test.ts`: web
  component and utility unit tests.
