# Local Development

This guide covers the local Relay developer workflow: prerequisites, setup,
service commands, data layout, and test organization.

## Prerequisites

- Node.js 22.19 or newer
- npm
- Python 3.12 or newer
- uv
- PostgreSQL — sessions, tasks, events, and artifacts always live in the
  database; see [Backend Database Migrations](#backend-database-migrations)
- Docker with the local daemon running
- Hardware virtualization for BoxLite
- API keys for the agents you plan to run

## Technology Stack

| Layer | Technology |
|---|---|
| Backend | [FastAPI](https://github.com/fastapi/fastapi), [SQLAlchemy](https://github.com/sqlalchemy/sqlalchemy), [Pydantic](https://github.com/pydantic/pydantic), [Alembic](https://github.com/sqlalchemy/alembic), [uv](https://github.com/astral-sh/uv) |
| Web | [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react), [Tailwind CSS](https://github.com/tailwindlabs/tailwindcss), [TanStack Query](https://github.com/TanStack/query), [Zustand](https://github.com/pmndrs/zustand) |
| Sandboxing | [BoxLite](https://github.com/boxlite-ai/boxlite) |
| Agents | [Claude Code](https://github.com/anthropics/claude-code), Codex, Pi, Kimi |

## Environment Files

Relay uses project-local env files at each runtime boundary:

- `backend/.env`: Python backend settings, migration database URL, and optional
  task scheduler tuning (`RELAY_TASK_SCHEDULER_ENABLED`,
  `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS`, `RELAY_TASK_SCHEDULER_MAX_DISPATCHES`,
  `RELAY_TASK_SCHEDULER_TIMEZONE`).
- `web/.env.local`: Next.js development proxy settings.
- `packages/relay-core/.env`: shared TypeScript runtime and agent credential
  defaults.
- `packages/relay-daemon/.env`: daemon connection, sandbox, workspace, and
  optional agent credential overrides.
- `packages/.env`: repository-wide fallback values.

Create backend settings from the example:

```bash
cp backend/.env.example backend/.env
```

Create web settings from the example:

```bash
cp web/.env.example web/.env.local
```

Create package settings from the example. `packages/.env` is the only one the
Quick start needs: `relay-core` loads it on import, before any package-local
file, so credentials placed there reach the core runtime, the daemon, and the
supervisor alike.

```bash
cp packages/.env.example packages/.env
```

Add a package-local file only to override that fallback for one package — for
example a different `OPENAI_BASE_URL` for the daemon than for the supervisor:

```bash
cp packages/relay-core/.env.example packages/relay-core/.env
cp packages/relay-daemon/.env.example packages/relay-daemon/.env
```

Set agent credentials in `packages/.env`, or in a package-local `.env` file to
override them for that package:

```bash
ANTHROPIC_API_KEY=...
OPENAI_API_KEY=...
OPENAI_BASE_URL=...       # optional compatible endpoint
OPENAI_MODEL=...          # optional
PI_API_KEY=...            # optional override
PI_BASE_URL=...           # optional override
PI_MODEL=...              # optional override
KIMI_API_KEY=...          # optional; Kimi agent via Moonshot API
KIMI_BASE_URL=...         # optional override
KIMI_MODEL=...            # optional override
MOONSHOT_API_KEY=...      # alternative Moonshot credential
```

Precedence, widest to narrowest: shell environment values always win, then a
package-local `.env`/`.env.local`, then the `packages/.env` fallback. A key
already set by a wider source is never overwritten by a narrower one.

Do not put long-lived secrets into prompts, events, artifacts, or memory.

## Setup

Install Node dependencies:

```bash
npm install
```

Run the active test suite:

```bash
npm test
```

Run only the TypeScript tests:

```bash
npm run test:ts
```

Run only the Python backend tests:

```bash
npm run test:py
```

`test:py` uses `UV_CACHE_DIR=.uv-cache` so dependency downloads and builds stay
inside the repository workspace.

## Pre-commit hooks

Relay uses [pre-commit](https://pre-commit.com/) to run lightweight checks before
every commit. The configuration lives in `.pre-commit-config.yaml`.

Install the Git hooks once after cloning (this also syncs the backend dev
environment):

```bash
make pre-commit-install
```

Run all hooks against the entire repository:

```bash
make pre-commit-run
```

By default the hooks run:

- `trailing-whitespace`, `end-of-file-fixer`, and syntax checks for YAML, TOML,
  JSON, and Python AST.
- `check-added-large-files`, `check-merge-conflict`, `detect-private-key`, and
  `mixed-line-ending`.
- A check that `backend/uv.lock` is in sync with `backend/pyproject.toml`.
- TypeScript type checks for workspace packages (`packages/tsconfig.json`) and
  the web app (`web/tsconfig.json`) when matching `.ts` or `.tsx` files change.

## Backend Database Migrations

See the canonical
[`backend/migrations/README.md`](../backend/migrations/README.md) for applying
Alembic migrations, storage settings, and importing legacy session files.

## BoxLite Devbox

Build and export the BoxLite devbox image:

```bash
make devbox-oci
```

You only need to rebuild and export the devbox image when `dockerfile` changes.
This convenience target performs both steps:

```bash
make run-fresh
```

To mount a specific host workspace into the Relay devbox:

```bash
make daemon WORKSPACE=/path/to/workspace
```

The host workspace mounts into the BoxLite guest at `/workspace`
(`GUEST_WORKSPACE`). The guest `agent` user's UID/GID is aligned to the host
owner so generated files keep sane ownership.

## Running Services

Start the Python backend:

```bash
make backend
```

The backend loads `backend/.env` and listens on `BACKEND_PORT`, defaulting to
`8790`. It also starts the background task scheduler by default, which promotes
due routines and dispatches assigned tasks to ready daemon nodes. Disable or
tune it with `RELAY_TASK_SCHEDULER_ENABLED`, `RELAY_TASK_SCHEDULER_INTERVAL_SECONDS`,
and `RELAY_TASK_SCHEDULER_MAX_DISPATCHES`. Override the port with:

```bash
make backend BACKEND_PORT=9000
```

Start a daemon connected to the backend:

```bash
make daemon
```

The daemon reads `packages/relay-daemon/.env`. If no `RELAY_SANDBOX_ID` is set
there, pass one for a single run:

```bash
make daemon SANDBOX_ID=sbx_local
```

Run the web UI in dev mode:

```bash
make web
```

The web dev server reads `web/.env.local`; set `RELAY_BACKEND_URL` there to
change the backend proxy target. The exported UI at `/` includes chat,
backlog, routines, MCP, skills, channels, and the admin page. You can also
override the backend URL for one run:

```bash
make web RELAY_BACKEND_URL=http://127.0.0.1:9000
```

Reconcile managed computers (only needed when testing managed-node
provisioning):

```bash
make supervisor
```

Remote daemons use the same outbound HTTP(S) protocol as local daemons:
enrollment or token-authenticated registration, heartbeats, command polling,
and run events. The backend URL must be reachable from the remote machine.
No inbound connection to the daemon is needed for this protocol.

The legacy `--provider command` supervisor option is an optional remote
bootstrap adapter. Its template must idempotently ensure the daemon is
running (for example, through the remote machine's service manager), and
must pass the remote workspace and backend URL explicitly. A bootstrap
process exiting does not mean the remote daemon disconnected: the supervisor
uses HTTP heartbeat state and allows 15 minutes for registration before
retrying bootstrap. Supervisor shutdown leaves remote daemons running.
The default managed provider remains `local-process`, which can also run on
a cloud host; it owns local process cleanup while daemon communication uses
HTTP. Managed instances that never become ready time out after 15 minutes.

BoxLite downloads a small guest bootstrap image independently of Docker. If
the host needs an outbound proxy for OCI registries, put the proxy URL in the
supervisor's local environment file so only managed daemon children inherit
it:

```dotenv
# packages/relay-supervisor/.env.local
RELAY_BOXLITE_PROXY_URL=http://127.0.0.1:7890
```

Relay maps this scoped setting to the standard HTTP/HTTPS proxy variables for
managed daemons and keeps loopback backend traffic in `NO_PROXY`. It does not
proxy the supervisor's own backend requests.

Stop Relay and BoxLite processes:

```bash
make stop
```

## Local API And Web UI

Start the local server mode:

```bash
make serve
# or choose a port:
make serve PORT=9000
```

By default, `make serve` listens on `127.0.0.1:8787`. It reads real state from
the configured database and `.relay/`; it does not seed, mock, or display dummy
work.

Canonical route groups:

```text
GET  /api
     /api/v1/auth/...
     /api/v1/threads/...
     /api/v1/tasks/...
     /api/v1/agents/...
     /api/v1/teams/...
     /api/v1/sandboxes/...
     /api/v1/daemon-nodes/...
     /api/v1/admin/...
     /api/v1/internal/chat/...
GET  /api/openapi.json
GET  /api/docs
GET  /api/redoc
```

The complete operation contract is in [HTTP API and Web URL Contract](api.md).
The backend serves the exported web UI from `web/out` on the canonical clean
paths. In development, `make web` starts Next.js and proxies `/api/:path*` and
`/profile-images/:path*` to the backend. Use the backlog and routine pages to
manage assigned work and recurring schedules; the backend scheduler dispatches
due routines and assigned tasks when daemon nodes are ready.

### Admin authentication

The administration API (`/api/v1/admin/*`) requires an admin session. For local
development, initialize the first admin explicitly with the helper script:

```bash
script/init_users.sh --password 'choose-a-strong-password'
```

By default this creates user `admin` with the `admin` role and binds it to
employee `admin` in department `administration`. A password must be supplied
with `--password` or `RELAY_INITIAL_ADMIN_PASSWORD`; there is no built-in
password. Pass `--username`, `--role`, `--email`, `--employee-id`,
`--department-id`, or `--department-name` to customize the initial user.

For a token-gated bootstrap instead, set `RELAY_ADMIN_TOKEN` and create the
first admin explicitly:

```bash
curl -X POST http://127.0.0.1:8790/api/v1/auth/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"token":"$RELAY_ADMIN_TOKEN","username":"admin","password":"secret123"}'
```

After bootstrap, log in to receive an `httpOnly` session cookie:

```bash
curl -X POST http://127.0.0.1:8790/api/v1/auth/login \
  -c cookies.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"secret123"}'
```

Then use the cookie for control-panel requests:

```bash
curl -b cookies.txt http://127.0.0.1:8790/api/v1/admin/daemon-nodes
```

## Data Layout

Session/task events, snapshots, artifacts, links, and token usage live in the
configured PostgreSQL database. The event log is the source of truth; snapshots
are materialized views rebuilt from events. Remaining generated operational
state lives under `.relay/` (repo root, daemon registry) and the daemon host's
private state directory (never mounted into an agent sandbox):

```text
.relay/daemon/{nodes,commands,runs,run-requests,events}/         # daemon registry state
~/.relay/daemon-nodes/<sandbox-id>/credentials/<employee>.token  # daemon auth token
~/.relay/daemon-nodes/<sandbox-id>/logs/*.jsonl                  # daemon structured logs
```

Legacy `.relay/sessions/` and `.relay/tasks/` trees are migration inputs only;
the runtime does not use them as its session/task store. Import them with
`relay migrate-local-sessions --data-dir <path>` — see
[`backend/migrations/README.md`](../backend/migrations/README.md).

## Source Map

```text
backend/relay/cli.py                          relay binary entrypoint
backend/relay/app.py                          FastAPI backend application
backend/relay/core/                           models, env, ids, logging, storage config
backend/relay/persistence/                    event-sourced session/task/daemon/agent/team/
                                              project stores; persistence/stores.py re-exports
backend/relay/security/auth.py                auth store and JWT helpers
backend/relay/sessions/controller.py          session mutation controller
backend/relay/sessions/bridge.py              session continuity and handoff
backend/relay/daemon_registry/node_backend.py daemon admission and run dispatch
backend/relay/daemon_registry/registry.py     daemon registry
backend/relay/tasks/scheduler.py              routine promotion and assigned-task dispatch
backend/relay/chat/integrations.py            chat integration glue
backend/relay/services/                       narrower runtime services (agent routing,
                                              managed nodes, computer limits, task/team dispatch)
backend/relay/api/                            HTTP routes split by domain (tasks, sessions,
                                              daemon nodes, sandboxes, auth, admin, chat, web,
                                              agents, managed nodes, teams, projects)
backend/migrations/                           Alembic backend storage migrations
packages/relay-core/src/index.ts              shared protocol and agent runtime exports
packages/relay-core/src/daemon-protocol.ts    TypeScript backend protocol types
packages/relay-core/src/commands.ts           agent command builders
packages/relay-core/src/prompts.ts            agent prompt builders
packages/relay-core/src/renderers.ts          stream-json and JSONL renderers
packages/relay-core/src/token-usage.ts        TokenUsage type and normalizeTokenUsage
packages/relay-chat/src/gateway.ts            RelayChatGateway — routes chat events to backend
packages/relay-chat/src/relay-client.ts       HTTP client for chat → backend calls
packages/relay-chat/src/identity.ts           StaticChatIdentityResolver
packages/relay-chat/src/commands.ts           shared /relay command parser
packages/relay-chat/src/providers/discord.ts  Discord adapter
packages/relay-chat/src/providers/telegram.ts Telegram adapter
packages/relay-chat/src/providers/lark.ts     Lark adapter
packages/relay-daemon/src/cli.ts              daemon binary entrypoint
packages/relay-daemon/src/index.ts            daemon runtime
packages/relay-daemon/src/box.ts              BoxLite VM setup
packages/relay-daemon/src/execution.ts        BoxLite execution manager
packages/relay-daemon/src/sandbox-session.ts  sandbox session lifecycle and agent preflight
web/src/components/BacklogPage.tsx            web task backlog view
web/src/components/RoutinesPage.tsx           web recurring routines view
web/                                          Next.js web frontend
```

Keep backend runtime code in `backend/relay/` (`core/`, `persistence/`,
`security/`, `sessions/`, `daemon_registry/`, `tasks/`, `chat/`, `services/`,
and `api/`), TypeScript protocol/client exports in `packages/relay-core/src/`,
daemon execution code in `packages/relay-daemon/`, and frontend code in
`web/`.

## Testing

```bash
npm run build
npm run test:ts
npm run test:py
npm test
```

Test coverage is organized as:

- `backend/tests/`: Python event stores, artifacts, controller behavior, linked
  task updates, daemon registry behavior, task scheduler/routine promotion, and
  HTTP API routes.
- `packages/relay-core/tests/handoff.test.ts`: prompt contracts, Codex verdict
  parsing, command generation, stream renderers, and BoxLite helpers.
- `packages/relay-chat/tests/chat.test.ts`: chat gateway, provider adapters,
  command parsing, and relay-client integration.
- `packages/relay-daemon/tests/daemon.test.ts`: daemon registration, command
  polling, and agent execution.
- `web/tests/status.test.ts`: web status derivation for daemon nodes and
  conversations.
- `web/tests/backlog.test.ts`: backlog filtering, sorting, and display helpers.
- `web/tests/agentStream.test.ts`, `web/tests/messageBlock.test.ts`,
  `web/tests/tokenUsage.test.ts`, `web/tests/manageAgents.test.ts`: web
  component and utility unit tests.

Use focused tests for behavior changes, then run the relevant layer before the
full `npm test`.

## Implementation Notes

- The backend is the control plane and must not execute agent CLIs in-process.
  The background `TaskScheduler` only promotes due routines and dispatches
  already-assigned tasks through daemon commands.
- Durable state is append-only; add events instead of mutating history.
- Snapshots are derived from event logs.
- Keep API state real: no seeded demo tasks, fake agent runs, or dummy
  artifacts.
- Agent execution belongs in the daemon and shared TypeScript runtime.
- Claude uses `--output-format stream-json`; Codex uses `exec --json`; render
  both through stream renderers instead of printing raw JSON.
- Pi versions differ: use `-P` only when `pi --help` advertises `-P` or
  `--print-streaming`; otherwise fall back to `-p`.
