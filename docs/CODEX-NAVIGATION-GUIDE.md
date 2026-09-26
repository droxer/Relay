# Codex Navigation Guide

Use this guide after `AGENTS.md`. The agent guide defines repository-wide
rules and invariants; this document answers three practical questions:

1. Where is the source of truth for a behavior?
2. Which neighboring surfaces must change with it?
3. What evidence belongs in the final review or PR diff packet?

Relay has no `CODEOWNERS` file. “Ownership” below means code ownership by
module and responsibility, not a named person or team.

## Fast Architecture Map

```text
web/ and relay-chat
        |
        | HTTP / SSE under /api/v1
        v
backend/relay/api/                 request validation and authorization
        |
        +--> sessions/             session state transitions and continuity
        +--> services/             cross-aggregate business operations
        +--> daemon_registry/      dispatch, leases, cancellation, liveness
        +--> tasks/                routine promotion and scheduling
        +--> persistence/          authoritative events and projections
                    |
                    v
             configured database

backend daemon command queue
        |
        v
packages/relay-daemon/             execution-plane process
        |
        v
packages/relay-core/               CLI commands, prompts, renderers, protocol
        |
        v
BoxLite or explicitly local execution
```

The backend is the control plane and never runs an agent process. The daemon is
the execution plane. Session and task event logs are authoritative; snapshots,
relational columns, list summaries, and dashboard rows are projections.

## Source-of-Truth Ownership

| Concern | Start here | Check alongside it |
| --- | --- | --- |
| FastAPI construction, middleware, lifespan | `backend/relay/app.py` | `backend/relay/api/deps.py`, API tests |
| Public URL and response contract | `backend/relay/api/contract.py`, domain route in `backend/relay/api/` | `docs/api.md`, `web/src/api.ts`, `packages/relay-core/src/api-url.ts` |
| Authentication and record access | `backend/relay/security/auth.py`, `backend/relay/api/helpers.py` | auth API tests and daemon-token tests |
| Session transitions | `backend/relay/sessions/controller.py` | `persistence/session_store.py`, session routes, linked task effects |
| Session continuity and handoff | `backend/relay/sessions/bridge.py`, `conversation.py`, `handoff.py` | core prompt tests and handoff tests |
| Task transitions and persistence | `backend/relay/persistence/task_store.py` | `api/task_routes.py`, `services/task_dispatch.py`, backlog/routine UI |
| Routine scheduling | `backend/relay/tasks/scheduler.py` | task store claim queries and scheduler tests |
| Agent routing and placement | `backend/relay/services/agent_routing.py` | agent routes, placement store, daemon registry scheduling |
| Daemon admission and dispatch | `backend/relay/daemon_registry/node_backend.py` | `registry.py`, `scheduling.py`, daemon protocol tests |
| Daemon command execution | `packages/relay-daemon/src/index.ts` | `sandbox-session.ts`, `execution.ts`, daemon tests |
| Local agent execution and configuration | `packages/relay-daemon/src/local-runtime.ts`, `runtime-profile.ts` | `process-supervisor.ts`, `agent-inventory.ts`, installer/doctor tests |
| CLI argv and prompt construction | `packages/relay-core/src/commands.ts`, `prompts.ts` | renderers, handoff tests, daemon execution |
| Shared TypeScript domain contracts | `packages/relay-core/src/` | Python response shapes and `web/src/types.ts` |
| Web transport boundary | `web/src/api.ts` | backend route and `web/src/types.ts` |
| Web server-state cache | `web/src/hooks/useRelayData.ts`, `useRelayMutations.ts` | session SSE/detail hooks and cache merge helpers |
| Web session streaming | `web/src/hooks/useSessionEvents.ts` | `lib/sessionEvents.ts`, `sessionEventMerge.ts`, `sessionPollMerge.ts` |
| Issues, project boards, and routines | `web/src/components/IssuesPage.tsx`, `BacklogPage.tsx`, `RoutinesPage.tsx` | `lib/issueQueues.ts`, `backlog.ts`, `routine.ts`, task API contract |
| Managed computers | `backend/relay/services/managed_nodes.py` | managed-node routes and `packages/relay-supervisor/` |
| Chat providers | `packages/relay-chat/src/gateway.ts`, `providers/` | backend chat routes and provider tests |
| Database schema | table declarations under `backend/relay/persistence/` | `backend/migrations/versions/`, schema-drift tests |

Compatibility imports are not the place for new implementation. Put new
Python behavior in the nested packages above and keep a compatibility shim only
when an existing import still requires one.

## Request Lifecycles

### Browser read

```text
web hook -> web/src/api.ts -> FastAPI route -> actor/access helper
         -> persistence query/projection -> JSON cache -> component
```

For a list-latency change, inspect all of the following before editing:

- response completeness, pagination, and summary/detail contracts;
- database filtering, ordering, indexes, and transferred columns;
- frontend query keys, polling interval, and cache merge behavior;
- mutations that change a second aggregate, such as a session updating a task.

The browser task board opts into `GET /tasks?view=summary`; the unqualified
public `GET /tasks` contract still returns complete task records. Treat the
projection as an explicit transport optimization, not a replacement contract.

### Session stream

```text
useSessionEvents -> GET /threads/{id}/events -> authorization header read
                 -> incremental event pages -> SSE batch/message
                 -> applySessionEventUnchecked -> TanStack Query cache
```

Never replace a cache entry with an older snapshot after SSE has advanced it.
Use the merge helpers under `web/src/lib/sessionPollMerge.ts` and keep event
application monotonic and idempotent.

### Agent run

```text
agent route -> agent routing -> ServerDaemonNodeBackend
            -> durable run request/command -> daemon poll
            -> relay-core command and renderer -> daemon events
            -> registry finalization -> session/task event append -> SSE
```

Any apparent shortcut that executes an agent from the backend violates the
control-plane boundary.

## Change-Surface Checklist

| If you change... | Also inspect... |
| --- | --- |
| A REST response shape | `web/src/api.ts`, `web/src/types.ts`, relay-core types, API contract tests |
| A session event | Python materialization, TypeScript materialization, SSE application, import/export |
| A task event | task materialization, scheduler/dispatch queries, backlog and routine views |
| A database column or index | table metadata, next Alembic migration, schema-drift tests, downgrade |
| A query ordering or limit | completeness/pagination, stable tie-breaker, supporting index, adversarial test |
| A TanStack Query mutation | every aggregate changed server-side, optimistic rollback, SSE race safety |
| An agent name or executor | validation, routing, command, prompt, renderer, UI labels, tests |
| Daemon delivery semantics | leases, retries, idempotency, cancellation, shutdown, daemon/backend tests |
| Workspace paths | traversal protection, thread isolation, local/cloud parity, workspace tests |
| A public browser route | app router, History API state, canonical API prefix, ADR-012 |

## How to Navigate Efficiently

Use CodeGraph first for symbol structure when it is available:

1. `codegraph_context` for the concern or behavior.
2. `codegraph_explore` for the small related symbol set.
3. `codegraph_callers`, `codegraph_callees`, or `codegraph_impact` before a
   cross-cutting change.

Use `rg` for route strings, event names, error messages, configuration keys,
comments, and tests. Once a concrete file is known, read the narrow surrounding
range rather than scanning the entire repository.

Useful literal searches:

```bash
rg -n 'relay_event\(|relay_task_event\(' backend/relay backend/tests
rg -n '@router\.(get|post|put|patch|delete)' backend/relay/api
rg -n 'queryKey|invalidateQueries|setQueryData' web/src
rg -n 'RELAY_[A-Z0-9_]+' backend packages web docs
```

Do not search generated `dist/`, `.next/`, `node_modules/`, `.relay/`, or
`web/out/` unless the task specifically concerns an artifact produced there.

## Verification by Surface

Run the narrowest relevant test first, then the complete suites before handoff.

```bash
# Python backend
UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev pytest backend/tests/path/to/test.py -q

# Compile TypeScript tests and run selected built tests
npx tsc -p packages/tsconfig.json
node --test dist/web/tests/status.test.js

# Production web type/build check
npm run build -w web

# Full repository suites
npm run test:py
npm run test:ts

# Database migration
make backend-migrate

# Repository hygiene
git diff --check
```

For large PostgreSQL indexes, use Alembic concurrent index operations inside
an autocommit block and call out the transaction boundary in deployment notes.

Use the owning test area:

- `backend/tests/api/` for HTTP authorization and response behavior;
- `backend/tests/unit/` for stores, controllers, migrations, and schedulers;
- `packages/*/tests/` for protocol, daemon, supervisor, and chat behavior;
- `web/tests/` for cache merges, domain utilities, rendering contracts, and
  source-level UI invariants;
- `backend/tests/unit/test_schema_drift.py` for migrated PostgreSQL schema
  versus SQLAlchemy metadata.

## Documentation Authority

- `AGENTS.md`: operational rules, invariants, commands, and tool guidance.
- `docs/CODEX-NAVIGATION-GUIDE.md`: current implementation ownership and
  change-surface navigation.
- `docs/api.md`: public HTTP and browser URL contract.
- `docs/local-development.md`: developer environment and service startup.
- `docs/adr/`: accepted durable decisions.
- `docs/system-architecture.md`: target architecture; verify implemented claims
  against code before relying on them.
- `docs/implementation-plan.md`: broader planned work, not proof of completion.

When documentation and executable code disagree, treat tests and current code
as implementation evidence, then update stale documentation in the same change.

## PR Diff Packet

Before review, provide a compact packet that lets another agent reconstruct the
change without rediscovering the repository:

```markdown
## Intent
- User-visible problem and expected behavior.

## Ownership / surfaces
- Primary modules changed.
- API, database, daemon, and frontend consumers affected.

## Invariants checked
- Control plane did not execute agents.
- Event logs remain authoritative.
- Authorization and employee scoping are unchanged or explicitly tested.
- Summary/list optimization preserves completeness and detail access.

## Data and migration
- Schema/index changes and Alembic revision.
- Backfill, locking, downgrade, and deployment-order notes.

## Cache and concurrency
- Query keys invalidated or updated.
- SSE/poll/mutation race behavior.
- Idempotency, lease, or retry behavior where applicable.

## Verification
- Focused tests with exact commands and results.
- Full Python and TypeScript results.
- Build/typecheck and `git diff --check` result.

## Residual risk
- Untested environment dependencies, scale assumptions, or rollout metrics.
```

Keep the packet evidence-based. Do not claim a latency, throughput, or memory
improvement without a measurement or a concrete reduction in bounded work,
transferred data, or round trips.
