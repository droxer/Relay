# Deploying Relay on Railway behind Cloudflare

This guide puts Cloudflare (DNS, TLS, CDN, WAF) in front of Relay on Railway.
It replaces the Vercel half of [deployment.md](deployment.md): the web UI is a
Cloudflare Worker serving the static export from every Cloudflare location
(or, optionally, its own Railway service) on a sibling subdomain, and the
browser calls the backend directly (section 8). The backend image does not
include the web UI.
Follow [deployment.md § 1](deployment.md#1-railway-postgres--backend) for the
backend service and Postgres, then come back here.

```
browser ─┐                ┌──────── Cloudflare (proxied DNS) ────────┐
         ├─ https ──────▶ │ app.example.com   Worker: static UI      │   (served at the edge, no origin)
daemons ─┴─ https ──────▶ │ api.example.com   adds X-Relay-Edge      │──▶ Railway: relay backend (1 replica) ─▶ Postgres
                          │                   caches daemon bundles  │
                          └──────────────────────────────────────────┘
```

The examples below use `api.example.com` for the backend. Any hostname works,
as long as the backend and the UI share one registrable domain.

[`deploy/deploy.sh`](../deploy/README.md) automates sections 1–3, 6 (given an
existing bucket), 8, and 9 through the Railway and Cloudflare APIs. The steps
below are what it does, and what to do by hand without it.

## 1. Domain and TLS

1. Railway → backend service → *Settings* → *Networking* → *Custom Domain*:
   add `api.example.com`. Railway shows the routing CNAME and ownership TXT.
2. Cloudflare → *DNS*: add that CNAME, **proxied** (orange cloud), and the
   verification TXT with exactly the name and value Railway supplies. Keep
   TXT and any `_acme-challenge` CNAME DNS-only. Both routing and verification
   records are required; a missing TXT leaves the domain unverified.
3. Cloudflare → *SSL/TLS*: mode **Full (strict)**. Railway issues the origin
   certificate for the custom domain; if issuance stalls, switch the record to
   DNS-only until Railway reports the certificate, then proxy it again.
4. Turn on *Always Use HTTPS*.

**Free certificates renew automatically.** Cloudflare Universal SSL handles the
browser-to-Cloudflare certificate, including renewal, at no certificate cost.
Railway issues and renews the origin's Let's Encrypt certificate. No Certbot
container or renewal cron is needed. Keep Universal SSL enabled, the zone
active, and Railway's verification and ACME records in DNS (ACME records stay
DNS-only). See [Cloudflare Universal SSL](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/)
and [Railway TLS](https://docs.railway.com/networking/domains/working-with-domains#ssl-certificates).

## 2. Lock the origin to Cloudflare

Railway offers no inbound IP allowlist, so the origin lock is a shared secret.
Cloudflare adds it to every request; the backend refuses requests without it.

1. Generate a secret: `openssl rand -hex 32`.
2. Cloudflare → *Rules* → *Transform Rules* → *Modify Request Header* → new
   rule matching requests to the API host (`http.host eq "api.example.com"`):
   **Set static** `X-Relay-Edge` to the secret, so it never reaches any other
   origin. *Set* overwrites any value a client sends, so the header cannot be
   forged through the edge.
3. Railway backend variables:

   | Variable | Value |
   | --- | --- |
   | `RELAY_EDGE_SECRET` | the secret |
   | `RELAY_CLIENT_IP_HEADER` | `CF-Connecting-IP` |
   | `RELAY_PUBLIC_BACKEND_URL` | `https://api.example.com` |
   | `RELAY_PUBLIC_WEB_URL` | `https://relay.example.com` |
   | `RELAY_FORCE_SECURE_COOKIES` | `1` |

   Leave `RELAY_TRUST_PROXY_HEADERS` unset: Railway's edge has no stable
   address range to trust, and `RELAY_FORCE_SECURE_COOKIES` already gives the
   cookie `Secure`. Leave `SameSite=Lax`; section 8 adds the CORS origin and
   cookie domain the separately hosted UI needs.

With `RELAY_EDGE_SECRET` set, any request that reaches the Railway domain
directly (`*.up.railway.app`) gets `403`. `/healthz` stays open because
Railway's health check calls the container directly.

`RELAY_CLIENT_IP_HEADER` matters for rate limits: behind Cloudflare every
request's socket peer is an edge address, so login and webhook limits would
otherwise lump all callers at one Cloudflare location into one bucket. Relay
reads the header only on a request that carried the edge secret, and refuses to
start if the header is set without the secret.

**Rotating the secret.** `RELAY_EDGE_SECRET` takes a comma-separated list.
Add the new secret to the list and redeploy, switch the Transform Rule to the
new value, then remove the old one from the list.

**Anything that calls the backend must go through the edge.** Daemons,
supervisors, and the chat gateway use `RELAY_PUBLIC_BACKEND_URL`, which is the
Cloudflare hostname, so they pick up the header there. A service calling the
backend over Railway's private network would be refused — point it at the
public hostname.

## 3. Caching

The backend already sends the right `Cache-Control` headers; the cache rules
make Cloudflare honor them and keep dynamic traffic out of the cache.

Cloudflare → *Caching* → *Cache Rules*, in this order:

| Match | Action | Why |
| --- | --- | --- |
| URI path starts with `/api/` | **Bypass cache** | JSON API and SSE streams. |
| URI path starts with `/profile-images/` | **Bypass cache** | Served `private`; access is per user. |
| URI path is `/install.sh` or `/computer/install.sh` | **Bypass cache** | Served `no-store`; it embeds the current bundle digest. |
| URI path starts with `/_next/static/` | Eligible for cache, edge TTL 1 year | Content-hashed filenames. |
| URI path starts with `/computer/daemon-` | Eligible for cache, respect origin TTL | Digest-named, served `immutable`. |

HTML pages fall through to Cloudflare's default (not cached), so a deploy is
visible immediately.

**Speed settings.** Turn these on as well; none of them touches response
bodies, so SSE is unaffected:

| Setting | Where | Effect |
| --- | --- | --- |
| HTTP/3 (with QUIC) | *Speed* → *Optimization* → *Protocol* | Faster connection setup, better on lossy mobile links. |
| 0-RTT Connection Resumption | same | A returning visitor sends its first request with the handshake. |
| Early Hints | *Speed* → *Optimization* → *Content* | `103` preload hints for scripts and styles while the page is in flight. |
| Smart Tiered Cache | *Caching* → *Tiered Cache* | An edge miss asks a regional Cloudflare cache before Railway — daemon bundles after a release reach Railway about once, not once per location. |

Leave off anything that rewrites or buffers responses — see section 4.

## 4. SSE

Thread streams are Server-Sent Events under `/api/`. Cloudflare closes a
proxied connection that sends nothing for 100 seconds; Relay sends a heartbeat
every 15 seconds, and the client reconnects with `Last-Event-ID` when a
connection ends, so the default `RELAY_STREAM_MAX_SECONDS` works. Keep the
`/api/` bypass rule above, and do not enable features that rewrite or buffer
responses on that path (Rocket Loader, Email Obfuscation, Zaraz).

## 5. Security rules

- **Rate limiting** (*Security* → *WAF* → *Rate limiting rules*): add an edge
  limit on `/api/v1/auth/` and `/api/v1/automations/*/webhook` as a first
  line; the backend's own limits stay in force behind it.
- **Bot protection:** daemons and supervisors are not browsers. Keep ordinary
  Bot Fight Mode disabled: WAF Skip rules cannot bypass it. If you use Super
  Bot Fight Mode or managed challenge rules, configure supported exceptions for
  `/api/v1/daemon-node`, `/api/v1/computer-authorizations`, `/install.sh`, and
  `/computer/` on the API host. Test enrollment, polling and bundle downloads.
  See [Cloudflare's limitations](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/#limitations).
- **Request body size:** Cloudflare's plan limit (100 MB on Free/Pro) sits
  above `RELAY_MAX_JSON_BODY_BYTES`, so the backend's limit is the one users hit.

## 6. R2 for artifact snapshots and skill bundles (optional)

Two kinds of bytes can live in R2:

- **Artifact snapshots** — generated workspace files (PDFs, decks, spreadsheets
  up to `RELAY_WORKSPACE_ARTIFACT_SNAPSHOT_MAX_BYTES`, 2 MB by default), kept so
  they stay downloadable after the computer that wrote them goes offline. By
  default they live in Postgres.
- **Skill bundles** — the files of every published skill revision. By default
  they live on disk under `<data dir>/skills/objects`, which is the one reason
  the backend would need a volume.

With R2 both go to the bucket (`session-artifacts/…`, `skills/objects/…`) and
Postgres keeps only keys and SHA-256 digests, so the backend needs no volume.
Profile images stay in Postgres: they are small and bounded.

1. Cloudflare → *R2* → create a bucket, e.g. `relay-artifacts`. Keep it
   private — no public access, no custom domain. The backend reads it and
   serves downloads itself, with the same authorization and headers as before.
2. *R2* → *Manage API tokens* → create a token with **Object Read & Write**
   scoped to that bucket only.
3. Railway backend variables:

   | Variable | Value |
   | --- | --- |
   | `RELAY_BLOB_STORE` | `r2` |
   | `RELAY_R2_ACCOUNT_ID` | your Cloudflare account ID |
   | `RELAY_R2_ACCESS_KEY_ID` | the token's access key ID |
   | `RELAY_R2_SECRET_ACCESS_KEY` | the token's secret |
   | `RELAY_R2_BUCKET` | `relay-artifacts` |

   For a bucket in a jurisdiction (EU, FedRAMP), also set `RELAY_R2_ENDPOINT`
   to that jurisdiction's endpoint.

The backend refuses to start if `RELAY_BLOB_STORE=r2` is missing any of these.
New snapshots and skill bundles go to R2 from then on. Deleting a thread
deletes its objects (`session-artifacts/<thread>/`). Do not switch back to
`database` while R2 holds data: snapshots would fall back to a live read from
their computer, and skill bundles would be missing.

**Moving existing bytes.** Snapshots already in Postgres keep being served
from there, and skill bundles in the data dir are copied to R2 the first time
they are read. To move everything at once — and be able to detach the volume —
run the backfill in the backend service (Railway → service → *Shell*, or a
one-off deploy command):

```bash
relay migrate-blobs-to-r2 --data-dir /data --dry-run   # counts only
relay migrate-blobs-to-r2 --data-dir /data
```

It uploads each item before clearing its row, so it is safe to interrupt and
re-run; it never deletes files from the data dir. When a run reports `0` for
everything, the volume can be detached.

## 7. Nightly database backups to R2

> **Not deployed yet.** The `relay backup-database` command and the image's
> Postgres client are in place, but no Railway service runs it. The steps
> below describe the intended setup; the cron service's configuration still
> has to be settled before following them.

Postgres is the source of truth for every thread, task, and event. A Railway
cron service on the same image runs `relay backup-database` once a night: it
`pg_dump`s the database into a temporary file, proves the archive is readable
with `pg_restore --list`, and only then uploads it. A failed or truncated dump
uploads nothing.

| Object | Written | Kept (lifecycle rule) |
| --- | --- | --- |
| `daily/relay-<UTC timestamp>.dump` | every run | 30 days |
| `monthly/relay-<UTC timestamp>.dump` | runs on the 1st of the month | 365 days |

1. **Bucket.** Cloudflare → *R2* → create `relay-backups`, private. Under its
   *Settings* → *Object lifecycle rules*, add: prefix `daily/` → delete after
   30 days; prefix `monthly/` → delete after 365 days.
2. **Token.** Create an R2 API token with **Object Read & Write** on
   `relay-backups` only. Keep it separate from the artifact token so the
   backend's everyday credentials cannot touch backups.
3. **Service.** In the Railway project → *New* → *GitHub repo* → this repo
   again. Set `RAILWAY_DOCKERFILE_PATH=backend/Dockerfile` before building.
   In the new service's *Settings*, set the *Custom Start Command* to `relay
   backup-database`, the *Cron Schedule* to `0 3 * * *` (03:00 UTC), and the
   *Restart Policy* to *Never*; clear the pre-deploy command and health check
   if copied from the backend service. Give it no domain.
4. **Variables** on the backup service:

   | Variable | Value |
   | --- | --- |
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `RELAY_BACKUP_R2_BUCKET` | `relay-backups` |
   | `RELAY_R2_ACCOUNT_ID` | your Cloudflare account ID |
   | `RELAY_BACKUP_R2_ACCESS_KEY_ID` | the backup token's access key ID |
   | `RELAY_BACKUP_R2_SECRET_ACCESS_KEY` | the backup token's secret |
   | `PG_CLIENT_MAJOR` | your Postgres major version (image default `18`; match the server) |

   `pg_dump` must be at least the server's major version. Railway passes
   `PG_CLIENT_MAJOR` to the image build, which installs that client from the
   PostgreSQL apt repository; check the server with `select version();` and
   rebuild after a Postgres major upgrade. Without the backup keys the
   command falls back to `RELAY_R2_ACCESS_KEY_ID`/`RELAY_R2_SECRET_ACCESS_KEY`.
5. **First run.** Deploy the service once by hand and check its log for
   `Database backup uploaded` and the object in the bucket.

**Restoring.** Restore into a fresh database first, check it, then repoint
the backend:

```bash
# Download the archive from the R2 dashboard (or any S3 client), then:
createdb relay_restore
pg_restore --no-owner --no-privileges --dbname=relay_restore relay-<timestamp>.dump
# Bring a restore up to the running code's schema before pointing the backend at it:
DATABASE_URL=postgresql://.../relay_restore alembic -c backend/alembic.ini upgrade head
```

To restore over the live database instead, stop the backend first and add
`--clean --if-exists`. Artifact snapshots and skill bundles live in the R2
buckets from section 6, not in the dump; keys in a restored database still
point at them.

## 8. The web UI

The UI is a static export in *direct* mode: the browser loads it from
`app.example.com` and calls `api.example.com` itself — the direct model of
[deployment.md](deployment.md#option-b--direct-on-sibling-subdomains). Do not
put a proxy for `/api` in front of the UI: a proxy reaches the backend through
Cloudflare from its own address, so `CF-Connecting-IP` would name the proxy for
every user and the backend's login rate limit would put them all in one bucket.

Whichever host serves it, the backend needs these variables so the browser may
call the API from the UI's origin with its session cookie:

| Variable | Value |
| --- | --- |
| `RELAY_CORS_ALLOW_ORIGINS` | `https://app.example.com` |
| `RELAY_SESSION_COOKIE_DOMAIN` | `.example.com` |

Sibling subdomains are same-site, so the cookie stays `SameSite=Lax`. The
backend caches the CORS preflight for two hours, so the cross-origin calls do
not pay an extra round trip each.

### Cloudflare Workers (default)

The export is uploaded to Workers static assets and served from every
Cloudflare location, so pages load without a round trip to Railway's region,
and there is no web container to run. A small Worker
([`deploy/workers/worker.js`](../deploy/workers/worker.js)) runs only when no
file matched: a path with a file suffix is a `404`, anything else is a client
route and gets the app shell — the same line `web/Caddyfile` draws.
[`deploy/workers/_headers`](../deploy/workers/_headers) carries the security
headers and marks `/_next/static/*` immutable; pages revalidate, so a deploy is
visible immediately.

1. **Build.** `NEXT_PUBLIC_RELAY_API_ORIGIN=https://api.example.com npm run
   build -w web` produces `web/out`. The value is inlined at build time.
   `deploy.sh` builds it in Docker from `web/Dockerfile`'s `build` stage, from
   the release commit, so the remote source never runs on the deploying
   machine.
2. **Publish** the Worker with its assets (direct-upload API, or `wrangler
   deploy` with `assets.directory = "web/out"`, `not_found_handling = "none"`,
   and `worker.js` as `main`). Unchanged files are not uploaded again.
3. **Route.** `app.example.com` needs a proxied DNS record; with none, add
   `AAAA app 100::` (proxied). Then add the Worker route `app.example.com/*`.
   A route answers in front of whatever record is there, so moving from the
   Railway service is zero-downtime: keep its proxied CNAME, add the route,
   and deleting the route is the rollback. Remove the Railway `relay-web`
   service once the checks in section 9 pass.

The section 3 cache rules do not apply to Worker assets, which come from
Cloudflare's asset store rather than the zone cache.

### Railway

To serve the UI from a Railway service instead (`web/Dockerfile`: the export
behind Caddy; `WEB_HOSTING=railway` for `deploy.sh`):

1. **Service.** Create an empty service, keeping the repository root as its
   root directory. Set `RAILWAY_DOCKERFILE_PATH=web/Dockerfile`, then configure
   builder `RAILPACK` with Dockerfile path `web/Dockerfile`, `/healthz` health
   check (60 seconds), one replica,
   restart on failure (10 retries), and no custom start or pre-deploy command.
   Set the API origin below before connecting the GitHub repository. The
   automated script applies `deploy/services/web.json` directly through the
   API; it does not use the deprecated Config-as-code path.
2. **Variable** on the web service:

   | Variable | Value |
   | --- | --- |
   | `NEXT_PUBLIC_RELAY_API_ORIGIN` | `https://api.example.com` |

   It is inlined at build time: the build fails without it, and changing it
   takes a redeploy, not a restart.
3. **Domain.** Add `app.example.com` as the service's custom domain and a
   proxied CNAME in Cloudflare, as in section 1. The UI's origin needs no
   lock — it serves only public static files.
4. **Caching.** The section 3 rules match on path, so they cover both
   hostnames. The web service sends `immutable` for `/_next/static/*` and
   `no-cache` for pages, so a deploy is visible immediately.

## 9. Verify

```bash
# Through the edge: 200
curl -sS -o /dev/null -w '%{http_code}\n' https://api.example.com/api/v1/auth/status
# Directly at Railway: 403
curl -sS -o /dev/null -w '%{http_code}\n' https://<service>.up.railway.app/api/v1/auth/status
# Health check is open on the origin: 200
curl -sS -o /dev/null -w '%{http_code}\n' https://<service>.up.railway.app/healthz
# Static assets are immutable (Workers); on Railway, cf-cache-status is HIT
# after the first request
curl -sSI https://app.example.com/_next/static/<any-asset> | grep -iE 'cache-control|cf-cache-status'
# The API is never cached: BYPASS or DYNAMIC
curl -sSI https://api.example.com/api/v1/auth/status | grep -i cf-cache-status
```

The web UI and its CORS grant:

```bash
# Any client route returns the app shell: 200
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/threads
# A missing asset is not the app shell: 404
curl -sS -o /dev/null -w '%{http_code}\n' https://app.example.com/_next/static/missing.js
# The API allows the UI's origin with credentials
curl -sSI -H 'Origin: https://app.example.com' https://api.example.com/api/v1/auth/status \
  | grep -i '^access-control-allow-'
```

Then sign in at `https://app.example.com`, open a thread with a running agent
and confirm the stream stays live for several minutes, and connect a daemon to
`https://api.example.com`.
