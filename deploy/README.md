# Deploying to Railway and Cloudflare

`deploy.sh` automates [docs/deployment-cloudflare.md](../docs/deployment-cloudflare.md):
it provisions Relay on Railway, puts Cloudflare in front of it, deploys, and
checks the result. It calls the Railway GraphQL API and the Cloudflare v4 API
directly, so it needs only `curl`, `jq`, `openssl`, `git`, `python3`, and
`docker` (to build the web export) — no `railway` or `wrangler` CLI.

| Host | Serves | Runs on |
| --- | --- | --- |
| `get-relay.cc` | web UI (static export) | Cloudflare Worker `relay-web` |
| `api.get-relay.cc` | API, SSE, daemons, install script (`backend/Dockerfile`) | Railway `relay-backend` |
| — | Procrastinate background jobs | Separate process in the same `relay-backend` container |
| — | database | Railway `Postgres` (template) |

Set `WEB_HOSTING=railway` to serve the UI from a Railway `relay-web` service
(`web/Dockerfile`, the export behind Caddy) instead; `docker` is then not
needed.

## Before the first run

1. **Cloudflare:** add `get-relay.cc` as a zone and point the registrar at
   Cloudflare's nameservers. Create an API token scoped to that zone with
   *Zone: Read*, *DNS: Edit*, *Zone Settings: Edit*, *Transform Rules: Edit*,
   *Cache Rules: Edit*, and *Workers Routes: Edit*, plus the account
   permission *Workers Scripts: Edit*.
2. **Railway:** create an account or workspace token (a project token cannot
   create projects), and give the Railway GitHub app access to
   `droxer/Relay`.
3. **Config:** `cp deploy/config.example.env deploy/.env` (or
   `deploy/config.env`) and fill in the two tokens. Git ignores both; never
   commit them.
4. **Optional R2:** to keep skill bundles and artifact snapshots in R2 instead
   of a Railway volume, create the bucket and its token by hand
   ([§ 6](../docs/deployment-cloudflare.md#6-r2-for-artifact-snapshots-and-skill-bundles-optional))
   and set the four `RELAY_R2_*` keys.

## Running it

```bash
deploy/deploy.sh up          # everything below, in order
deploy/deploy.sh railway     # project, Postgres, services, variables, volume, custom domains
deploy/deploy.sh cloudflare  # DNS records, TLS Full (strict), origin-lock header, cache rules, speed settings
deploy/deploy.sh release     # deploy the backend, then build and publish the web UI Worker
deploy/deploy.sh verify      # probe the live hostnames
deploy/deploy.sh agent-ids   # read Computer ID migration status from backend startup logs
deploy/deploy.sh region      # move Postgres and the services to RAILWAY_REGION (see below)
```

Every step looks before it writes, so re-running converges and changes nothing
that is already right. After the first run, `deploy.sh release` is the whole
redeploy. It resolves `GITHUB_BRANCH` once and passes the same commit SHA to
both deployments. It also updates an existing backend's startup settings for
the supervised API/worker pair, so this upgrade needs no separate `railway`
phase. For private repositories configure Git credentials, or set
`RAILWAY_DEPLOY_COMMIT` to a full 40-character SHA. Railway also autodeploys
pushes to the connected branch; changing the branch on an existing service
requires updating its source settings in Railway.

The first `railway` run prints the generated `RELAY_ADMIN_TOKEN` once. Keep
it: it seeds the admin bearer token on the backend's first boot. Later runs
read secrets back from Railway and never rotate them.

Railway publishes a custom domain's DNS records shortly after the domain is
added. If `cloudflare` warns that they are not ready, re-run it a minute later.
Certificates are issued through the `_acme-challenge` records, which stay
DNS-only, so the traffic records can be proxied from the start.

The Computer ID data migration runs automatically when the backend starts,
including production deployments through `up` or `release`. After deployment,
run `deploy.sh agent-ids` to read its status from the newest successful backend
deployment's logs, even if a later release failed. This command only reads
Railway: it does not create resources or require direct database access.
It exits successfully for `agent-computer-ids converged`, and nonzero for
pending records, missing status logs, or no recent successful deployment.
The result is a startup snapshot; daemon registration may repair records
afterward. For a current read against an accessible database, run
`relay check-agent-computer-ids` with that database's `DATABASE_URL`.

## The web UI Worker

`release` builds the export of the release commit in Docker (`web/Dockerfile`'s
`build` stage, fed by `git archive`, so nothing from the working tree is used
and the remote source never runs on this machine) while Railway builds the
backend. Once the backend deployment succeeds, it uploads the export through
the Workers direct-upload API (`workers_deploy.py`; files Cloudflare already
holds are skipped) together with `workers/worker.js` and `workers/_headers`,
then routes `get-relay.cc/*` to the Worker. A failed backend leaves the
previous UI in place. The Worker redirects `/install.sh` to the API origin
(its `RELAY_API_ORIGIN` binding), so the published
`curl -fsSL https://get-relay.cc/install.sh | bash` reaches the script.

`cloudflare` gives the web host a proxied record: an existing one is kept,
otherwise it adds `AAAA 100::`. Moving from the Railway web service is
therefore zero-downtime — the route answers in front of the old CNAME — and
deleting the route in the dashboard is the rollback. Once `verify` passes,
delete `relay-web` in Railway; the script never deletes services, records, or
someone else's route.

## Railway service configuration

The script sends explicit settings from `deploy/services/backend.json` and
`deploy/services/web.json` to `serviceInstanceUpdate`. It clears the legacy
Config as Code path, sets the Dockerfile, migration command, health check,
restart policy, and replica count before connecting the repository. The API
builder is `RAILPACK`; Railway uses the specified Dockerfile when present.
`DOCKERFILE` was a config-file value and is not a GraphQL `Builder` enum. The backend
stays always-on for its scheduler. No `railway.json` or `railway.toml` is used.
Railway's CLI IaC is an alternative management workflow; this script uses the
public API directly and does not evaluate `.railway/railway.ts`.

Connecting a repository may trigger an automatic deployment. The release phase
also requests an explicit deployment pinned to the intended SHA and waits for
that ID; it does not assume an implicit build is the requested release.

The backend's single pre-deploy command runs `/bin/sh -c` to apply Relay's
Alembic migrations and then initialize the Procrastinate schema
(`relay worker-schema`, idempotent), joined with `&&` so a failed migration
stops deployment. Railway accepts at most one entry in `preDeployCommand`.
`relay serve-with-worker` starts the API (`relay serve`) and background worker
(`relay worker`) as supervised processes, with `RELAY_BACKGROUND_MODE=external`.
They share the database, configuration, and `/data` skill files; no additional
Railway service or domain is needed. This also works without R2, since separate
Railway containers cannot share the backend's local skill directory.

If either child exits unexpectedly, the supervisor stops the other and exits
with an error so Railway restarts the complete service. On SIGTERM/SIGINT it
forwards termination and allows 30 seconds for shutdown before killing any
remaining child. The script sets `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` to at
least 35, preserving a longer existing value. The `/healthz` check stays on
the API process. Deployment success is not a check that a scheduled job has
completed; inspect worker/job logs and PostgreSQL heartbeats for that.

For an operational rollback to embedded scheduling, use start command `relay`
and `RELAY_BACKGROUND_MODE=embedded`, then redeploy. Keep the queue schema and
records. The next scripted `railway` or `release` run restores the supervised
configuration; reverting permanently also requires reverting these settings
in the deployment scripts. No production changes are made just by editing
the files locally.

## Region

Every API call crosses the distance between Cloudflare and Railway, so the
services run in `RAILWAY_REGION`, near the users (default
`asia-southeast1-eqsg3a`, Singapore; production moved there from US East on
2026-10-16, which cut a warm API call from ~300 ms to ~110 ms from Shanghai).
`railway` applies it to every service it configures as `multiRegionConfig`,
clearing any other region so a changed value moves a service rather than
adding a second copy; it takes effect on the next deploy. A new Postgres is
redeployed into the region right away, while it is still empty. An existing
Postgres is never moved by `railway`: that migrates its volume offline, so a
re-run only warns when the database sits elsewhere.

### Moving region

`deploy.sh region` moves Postgres, then the backend, then the Railway web
service if there is one, redeploying each in `RAILWAY_REGION` and stopping at
the first that does not come up. The API is down while the Postgres volume
migrates (about a minute for 125 MB). It refuses to run unless
`CONFIRM_REGION_MOVE` names the target region. Back up first:

1. Railway → *Postgres* → *Settings* → *Networking* → add a **TCP proxy** on
   port 5432 (the database is private otherwise; Hobby workspaces have no
   manual volume backups).
2. Dump with a `pg_dump` of the server's major version (Postgres 18 here):
   `docker run --rm -e PGHOST -e PGPORT -e PGUSER -e PGPASSWORD -e PGDATABASE -v "$HOME/relay-backups:/out" postgres:18 pg_dump --format=custom --no-owner -f /out/prod.dump`
   with the proxy host/port and the service's `PGUSER`/`PGPASSWORD`/`PGDATABASE`.
3. Prove it restores: load it into a throwaway `postgres:18` container and
   compare row counts (`sessions`, `users`, `session_events`, `alembic_version`)
   with production.
4. `RAILWAY_REGION=<region> CONFIRM_REGION_MOVE=<region> deploy/deploy.sh region`,
   then `deploy/deploy.sh verify`, and compare the row counts again.
5. **Delete the TCP proxy.**

Set `RAILWAY_REGION` in `deploy/.env` too, or the next `railway` run will
place the services back in the old region.

## Interrupted runs

Railway read requests retry transient connection failures up to three times,
with short backoff. Mutations are not replayed automatically because a lost
response may follow a successful write. After an interruption, re-run the
failed phase; existing services, DNS records and secrets are reused. If `up`
stops during Cloudflare setup, resume with:

```bash
deploy/deploy.sh cloudflare
deploy/deploy.sh release
deploy/deploy.sh verify
```

## What it sets

**Backend variables:** `DATABASE_URL` (a reference to `Postgres`),
`RELAY_STORAGE=postgres`, `RELAY_BACKGROUND_MODE=external`,
`RAILWAY_DEPLOYMENT_DRAINING_SECONDS` (minimum 35),
`RELAY_PUBLIC_BACKEND_URL`, `RELAY_PUBLIC_WEB_URL`, `RELAY_CORS_ALLOW_ORIGINS`,
`RELAY_SESSION_COOKIE_DOMAIN=.get-relay.cc`, `RELAY_FORCE_SECURE_COOKIES`,
`RELAY_EDGE_SECRET`, `RELAY_CLIENT_IP_HEADER=CF-Connecting-IP`,
`RELAY_ADMIN_TOKEN`, and the R2 keys when configured. **Web:**
`NEXT_PUBLIC_RELAY_API_ORIGIN` and `NEXT_PUBLIC_RELAY_SITE_URL` (the web
origin, which makes the landing page indexable) are baked into the export at
build time (build arguments for the Worker, service variables with
`WEB_HOSTING=railway`).

**Cloudflare:** a proxied CNAME for the API host and a proxied record plus
Worker route for the web host, DNS-only ACME and ownership records, SSL *Full
(strict)*, *Always Use HTTPS*, HTTP/3, 0-RTT, Early Hints, Smart Tiered Cache,
a Transform Rule that adds `X-Relay-Edge` to requests for the API host only,
and the five cache rules from § 3. Rules the script owns have a `relay_` ref. Rules without one are left
alone, and it never deletes a DNS record: if a host already points somewhere
else, the run stops and says which record to remove.

## Not automated

- WAF rate-limiting and bot rules (§ 5): plan-dependent, so add them in the
  dashboard.
- The R2 bucket, its lifecycle rules, and its API token.
- Nightly database backups (§ 7), which are not deployed yet.

## Certificate renewal

Cloudflare Universal SSL and Railway's origin certificates are free and renewed
automatically by their providers. No renewal job is needed. Keep Universal SSL
enabled and preserve Railway's DNS verification and ACME records; see
[Domain and TLS](../docs/deployment-cloudflare.md#1-domain-and-tls).

## Rotating the edge secret

Set `RELAY_EDGE_SECRET=<old>,<new>` in `deploy/.env` and run
`deploy.sh railway`, `deploy.sh release`, then `deploy.sh cloudflare`. The
backend then accepts both secrets, and the edge sends the last one. Then set it
to `<new>` alone and run `railway` and `release` again.

## Source changes and releases

`release` builds the selected GitHub commit, not the local working tree.
Before any deployment request, it fetches that exact commit into a temporary
Git object database and checks required backend/web build files and Railway
cache-mount constraints, including the worker and process-supervisor modules.
This happens before upgrading service configuration or requesting deployments.
It never checks out or runs remote files outside a
container: Railway builds the services, and the web export builds inside
Docker. With `WEB_HOSTING=railway`, both services are checked even when one
fails; failure output includes deployment IDs, the
commit SHA, and build/runtime log tails. Log retrieval is best effort. Commit
and push Dockerfile or source fixes to the connected branch before releasing,
or push a commit and select its full SHA with `RAILWAY_DEPLOY_COMMIT`.

The backend uses Docker layer caching. Railway's cache mounts require literal
service-scoped IDs, so uv cache mounts are omitted to keep the image portable
across backend and backup services and different Railway projects.

## Tests

```bash
deploy/tests/run.sh
```

This runs the script against `tests/mock_api.py`, an in-memory stand-in for
both APIs (including Workers direct upload and routes), with Docker stubbed.
It runs a full provision, then a second run that must create or change nothing
and upload no unchanged asset, a move from the Railway-hosted UI, the
`WEB_HOSTING=railway` path, then the failure cases that must stop a run. The source checks validate committed Git fixtures, including a broken commit
whose working tree is already fixed. The mock rejects deprecated Config as Code, requires pinned release commits,
and checks foreign DNS conflicts. The API field shapes were checked against
Railway's live GraphQL schema, but no real account deployment is validated by
these tests. The first real `up` still needs end-to-end verification.
