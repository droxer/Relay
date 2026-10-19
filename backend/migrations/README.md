# Backend Migrations

This is the canonical guide for Relay's Alembic migrations. Migration files
live in this directory.

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

Accounts, users, departments, login sessions, sessions, session events,
retained artifact content, token usage, tasks, task events, thread-task links,
daemon nodes and their command queue, agents, teams, agent placements, and chat
integrations always live in the database. `RELAY_STORAGE`, `RELAY_AUTH_STORE`,
`RELAY_DAEMON_STORE`, and `RELAY_CHAT_STORE` are retired and ignored apart from
a warning.

## Retired file-backed stores

The legacy file importers and their `migrate-local-*` CLI commands have been
removed. Startup reads the configured database and does not import or reject
old file-store directories. Installations with unmigrated files must complete
the import using an earlier release before upgrading. Back up the database and
source files before that migration. This release leaves existing files and
database import markers untouched.
