# Deploying to Railway and Cloudflare

`deploy.sh` automates [docs/deployment-cloudflare.md](../docs/deployment-cloudflare.md):
it provisions Relay on Railway, puts Cloudflare in front of it, deploys, and
checks the result. It calls the Railway GraphQL API and the Cloudflare v4 API
directly, so it needs only `curl`, `jq`, `openssl`, `git`, and `python3` — no `railway` or
`wrangler` CLI.

| Host | Serves | Railway service |
| --- | --- | --- |
| `get-relay.cc` | web UI (`web/Dockerfile`, static export behind Caddy) | `relay-web` |
| `api.get-relay.cc` | API, SSE, daemons, install script (`backend/Dockerfile`) | `relay-backend` |
| — | database | `Postgres` (Railway template) |

## Before the first run

1. **Cloudflare:** add `get-relay.cc` as a zone and point the registrar at
   Cloudflare's nameservers. Create an API token scoped to that zone with
   *Zone: Read*, *DNS: Edit*, *Zone Settings: Edit*, *Transform Rules: Edit*,
   and *Cache Rules: Edit*.
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
deploy/deploy.sh cloudflare  # DNS records, TLS Full (strict), origin-lock header, cache rules
deploy/deploy.sh release     # connect the repo (first time), deploy both services, wait
deploy/deploy.sh verify      # probe the live hostnames
```

Every step looks before it writes, so re-running converges and changes nothing
that is already right. After the first run, `deploy.sh release` is the whole
redeploy. It resolves `GITHUB_BRANCH` once and passes the same commit SHA to
both deployments. For private repositories configure Git credentials, or set
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
`RELAY_PUBLIC_BACKEND_URL`, `RELAY_CORS_ALLOW_ORIGINS`,
`RELAY_SESSION_COOKIE_DOMAIN=.get-relay.cc`, `RELAY_FORCE_SECURE_COOKIES`,
`RELAY_EDGE_SECRET`, `RELAY_CLIENT_IP_HEADER=CF-Connecting-IP`,
`RELAY_ADMIN_TOKEN`, and the R2 keys when configured. **Web variables:**
`NEXT_PUBLIC_RELAY_API_ORIGIN`, which is baked in at build time.

**Cloudflare:** proxied CNAMEs for both hosts, DNS-only ACME and ownership
records, SSL *Full (strict)*, *Always Use HTTPS*, a Transform Rule that adds
`X-Relay-Edge` to requests for the API host only, and the five cache rules from
§ 3. Rules the script owns have a `relay_` ref. Rules without one are left
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
cache-mount constraints. It never checks out or runs remote files. Both services
are checked even when one fails; failure output includes deployment IDs, the
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
both APIs. It runs a full provision, then a second run that must create or
change nothing, then the failure cases that must stop a run. The source checks validate committed Git fixtures, including a broken commit
whose working tree is already fixed. The mock rejects deprecated Config as Code, requires pinned release commits,
and checks foreign DNS conflicts. The API field shapes were checked against
Railway's live GraphQL schema, but no real account deployment is validated by
these tests. The first real `up` still needs end-to-end verification.
