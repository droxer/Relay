# Contributing to Relay

Relay is one repository with a Python control plane, TypeScript execution packages, and a Next.js web UI. This guide shows where things live and what to run before you open a pull request.

## Get set up

Follow the [quick start](README.md#quick-start) to run the backend, a daemon, and the web UI locally. [Local Development](docs/local-development.md) covers environment files, migrations, the supervisor, and shutdown commands in full.

## Where things live

```
backend/                  Python / FastAPI control plane
  relay/api/              HTTP routes, one module per domain (threads, tasks, agents, teams, projects, admin …)
  relay/persistence/      Event-sourced stores for sessions, tasks, agents, teams, and projects
  relay/sessions/         Session controller, handoff, and conversation continuity
  relay/daemon_registry/  Computer admission, command leases, run dispatch
  relay/tasks/            Scheduler that promotes routines and dispatches assigned issues
  relay/services/         Assignment, workspaces, team and project runtime rules
  relay/security/         Auth store, JWT, password policy, rate limiting
  migrations/             Alembic migrations
  tests/                  pytest suite
packages/                 TypeScript (npm workspaces)
  relay-core/             Shared protocol and pure helpers: agent registry, CLI commands, prompts, renderers
  relay-daemon/           Execution plane: registers a computer, polls for commands, runs agent CLIs
  relay-supervisor/       Keeps employee daemons provisioned and running
  relay-chat/             Chat channel gateway — the feature is disabled by default
web/                      Next.js web UI, exported statically and served by the backend
  src/components/         Pages and UI, grouped by surface
  src/lib/                Routing, derivations, and other pure helpers
  src/i18n/               English and Simplified Chinese strings
  tests/, e2e/            Unit tests and Playwright specs
docs/                     Architecture, API, deployment, design system, and ADRs (docs/adr)
script/                   User bootstrap, demo seeding, README snapshot generator
devbox/, dockerfile       The BoxLite guest image that sandboxed agents run in
```

## Where to start a change

| To change… | Start in |
|---|---|
| An API route or its response shape | `backend/relay/api/`, then `web/src/api.ts` and `web/src/types.ts` |
| How session or task state evolves | `backend/relay/persistence/` — state changes go through `append_event`, never a direct write |
| What a daemon and the backend say to each other | `packages/relay-core/src/daemon-node-protocol.ts` and `backend/relay/daemon_registry/` |
| How an agent CLI is launched or its output parsed | `packages/relay-core/src/agents.ts`, `commands.ts`, and `web/src/lib/agentStream.ts` |
| A page in the web UI | `web/src/components/`, with its strings in `web/src/i18n/locales/` |
| A database column | A new Alembic migration in `backend/migrations/` |

## Rules the codebase depends on

[`CLAUDE.md`](CLAUDE.md) lists the invariants in full. The ones most often relevant:

- **The backend never executes agents.** All execution flows through daemon commands.
- **The event log is authoritative.** Snapshots and materialized fields are derived from it.
- **Mutations return new objects.** Session and task updates do not modify state in place.
- **Agent identity is registry-driven.** Adding an agent starts with one `AGENT_REGISTRY` entry.

Design decisions are recorded as ADRs in [`docs/adr/`](docs/adr/README.md). Add one when a change settles a question others will ask again.

## Before you open a pull request

Run the checks that cover what you touched:

```bash
npm test                   # TypeScript suite and Python backend suite
make backend-test          # backend only
npm run test:react -w web  # web component tests
make pre-commit-run        # the hooks that run on every commit
```

Then:

- Update the matching page under [`docs/`](docs/README.md) when behavior changes.
- Regenerate the README snapshots when a change alters a surface they show:

  ```bash
  npm run build -w web
  node script/readme-snapshots/capture.mjs
  ```

- Use a conventional commit message: `feat:`, `fix:`, `refactor:`, `docs:`, `test:`, `chore:`, `perf:`, or `ci:`.
