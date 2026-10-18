# Backend Migrations

This is the canonical guide for Relay's Alembic migrations and legacy session
import. Migration files live in this directory.

## Apply migrations

Set `RELAY_DATABASE_URL` in `backend/.env`, then run:

```bash
make backend-migrate
```

Override the database URL for one run when needed:

```bash
make backend-migrate DATABASE_URL=postgresql+psycopg://relay:relay@localhost:5432/relay
```

To invoke Alembic directly:

```bash
RELAY_DATABASE_URL=postgresql+psycopg://relay:relay@localhost:5432/relay \
  UV_CACHE_DIR=.uv-cache uv run --project backend --extra dev \
  alembic -c backend/alembic.ini upgrade head
```

`RELAY_DATABASE_URL` takes precedence over `DATABASE_URL`; both override the
placeholder URL in `backend/alembic.ini`. Shell values take precedence over
`backend/.env`.

Sessions, session events, retained artifact content, token usage, tasks, task
events, thread-task links, daemon nodes and their command queue, agents, teams,
agent placements, and chat integrations always require the database. Set
`RELAY_STORAGE=postgres` (or the legacy `RELAY_AUTH_STORE=database`) to store
accounts there too. `RELAY_DAEMON_STORE` and `RELAY_CHAT_STORE` are retired and
ignored.

## Import legacy daemon, agent, team, placement, and chat files

Older installs kept those aggregates as JSON under the data directory
(`daemon/{nodes,commands,runs,run-requests,events}/`, `agents/`, `teams/`,
`agent-placements/`, `chat/`). The backend imports them automatically, once,
at startup, logging what it imported; the files are never modified or
deleted. To preview or run the import by hand:

```bash
uv run --project backend relay migrate-local-file-stores --data-dir .relay --dry-run
uv run --project backend relay migrate-local-file-stores --data-dir .relay
```

A record that already exists in the database with different content stops the
import (and startup) with an error naming it; nothing is written until the
conflict is resolved. Chat provider secrets are encrypted on import, so set
`RELAY_CHAT_SECRET_KEY` when `chat/secrets.json` exists.

## Import legacy session files

Stop the backend and back up PostgreSQL and `.relay`. Validate the legacy event
logs before writing rows:

```bash
RELAY_DATABASE_URL=postgresql+psycopg://relay:relay@localhost:5432/relay \
  uv run --project backend relay migrate-local-sessions \
  --data-dir .relay --dry-run
```

Remove `--dry-run` to import. The command is idempotent when the database has
the same ordered event history and fails on divergent session IDs. It never
edits or deletes the source directory; keep that directory read-only through
the rollback window.
