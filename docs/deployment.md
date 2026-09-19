# Deploying Relay on Vercel + Railway

This guide deploys Relay as a hosted product: the **web UI on Vercel** and the
**backend control plane on Railway** with Railway Postgres. It covers the two
origin models, the settings each one needs, and what deliberately stays off both
platforms.

## What goes where

Relay splits into a control plane and an execution plane, and that split decides
the hosting:

| Component | Host | Why |
| --- | --- | --- |
| `web/` (Next.js UI) | **Vercel** | Static/edge-friendly client app; no server state. |
| `backend/` (FastAPI) | **Railway** | Long-lived process: SSE streams, daemon command queue, background task scheduler. |
| Postgres | **Railway** | Sessions, tasks, events, auth, daemon registry. |
| `relay-daemon` | **Neither** | Runs where the sandbox lives — see below. |
| `relay-supervisor` | **Depends on its provider** | Control plane with `--provider command`, execution plane with `--provider local`. See [The supervisor](#the-supervisor). |

**Daemons do not belong on Vercel or Railway.** The backend never executes
agents; it queues commands that daemons poll for. A daemon in its default mode
boots a BoxLite microVM, which needs hardware virtualization that neither
platform's containers provide. Daemons run on employee machines (`SANDBOX_MODE=none`)
or on a VM host you control, and they connect *out* to the Railway backend URL —
so the backend needs a public URL, but daemons never need inbound ports.

You *can* run a daemon in a plain container with `--sandbox none`, where agents
are host processes rather than VM guests. That trades the sandbox boundary for
container isolation only, and you must supply each agent CLI's credentials in
the image. Relay requires `--allow-host-agent-execution` (or
`RELAY_ALLOW_HOST_AGENT_EXECUTION=1`) so this trust decision cannot happen by
accident. Treat it as a deliberate choice, not the default.

### The supervisor

`relay-supervisor` reconciles requested managed computers into running daemons.
Where it can be hosted depends entirely on which provider it uses, because the
two providers put it on opposite sides of the control/execution split:

- **`--provider local`** (the default) spawns `relay-daemon` as a child process
  on its own host (`LocalProcessProvider`), and defaults to `--sandbox boxlite`.
  That makes it an execution-plane component: it inherits every daemon
  constraint, including hardware virtualization, and does not belong on Railway.
- **`--provider command`** renders a command template — `gcloud workstations
  ssh …`, `ssh`, a cloud API call — that starts the daemon on infrastructure
  you control. The supervisor itself then runs no agents and no sandbox, so it
  is deployable next to the backend as a second Railway service.

Either way it is **never a Vercel workload**: it is a reconcile loop
(`--interval-ms`, default 10s), and in command mode it holds a live child
process per launched daemon rather than dispatching and forgetting.

If you deploy it on Railway with `--provider command`:

- It authenticates to the backend with `RELAY_ADMIN_TOKEN` as a bearer token,
  so that variable must stay set on the backend and be given to the supervisor
  service. That is a standing admin credential — see
  [Secrets](#secrets).
- Node tokens are interpolated into a shell command line (`shell: true`), so
  they are visible in the process table of whatever host runs the template.
  Keep that host dedicated.
- Restarts kill the child processes it is holding. Reconciliation restarts them
  on the next pass, but a redeploy is a disruption, not a no-op.
- Run one replica, for the same reason the backend does: two supervisors
  reconcile the same desired state against the same nodes.

`--once` runs a single reconcile pass and exits, which suits a scheduled job
better than a long-lived service if your provider template is fully
fire-and-forget.

```
   browser
      │
      ▼
┌───────────────┐   /api/*  ┌──────────────────┐      ┌────────────┐
│ Vercel (web)  │──────────▶│ Railway (backend)│─────▶│  Postgres  │
└───────────────┘           └──────────────────┘      └────────────┘
                                     ▲
                          poll commands │ post run events
                                     │
                      ┌──────────────────────────────┐
                      │ daemons: laptops / VM hosts   │
                      │ (BoxLite sandbox + agent CLIs)│
                      └──────────────────────────────┘
```

## Pick an origin model first

Relay authenticates with an HTTP-only session cookie. Where the browser sends
that cookie is the only real decision in this deployment, and everything else
follows from it.

### Option A — Proxied (recommended; no custom domain needed)

Vercel rewrites `/api/*` and `/profile-images/*` to the Railway backend. The
browser only ever talks to the Vercel origin, so the cookie stays same-origin:
default `SameSite=Lax`, no CORS, nothing to configure on the cookie at all.

Use this to get running on `*.vercel.app` and `*.up.railway.app` without owning
a domain. The cost is that every API call takes an extra network hop, and
long-lived SSE streams pass through Vercel's proxy — cap them (see
[SSE through a proxy](#sse-through-a-proxy)).

### Option B — Direct, on sibling subdomains

Point `app.example.com` at Vercel and `api.example.com` at Railway. The browser
calls the backend directly: no proxy hop, and SSE streams go straight to Railway.
Sibling subdomains of one registrable domain are *same-site*, so the cookie stays
`SameSite=Lax` — it just needs `Domain=.example.com`. The backend needs CORS
because the origins differ.

This is the better steady state once you have a domain. Requires DNS.

> **Not recommended: direct across unrelated domains.** `relay.vercel.app` →
> `relay.up.railway.app` is *cross-site* (both are public suffixes), so the
> cookie needs `SameSite=None; Secure`, which browser tracking-prevention modes
> increasingly block outright. Relay supports it
> (`RELAY_SESSION_COOKIE_SAMESITE=none`), but expect Safari and hardened Chrome
> profiles to drop the session. Use Option A instead.

## 1. Railway: Postgres + backend

1. **Create the project and database.** New project → *Provision Postgres*.
   Railway exposes `DATABASE_URL` on the database service.

2. **Add the backend service** from this repo. `railway.json` at the repo root
   already selects the build and deploy settings:
   - builds `backend/Dockerfile` (backend only — no agent CLIs, no BoxLite);
   - runs `alembic -c backend/alembic.ini upgrade head` as the pre-deploy
     command, so migrations land before the new container takes traffic;
   - health-checks `/healthz`;
   - pins `numReplicas: 1` — see [Run one replica](#run-one-replica).

3. **Reference the database.** In the backend service's variables, add
   `DATABASE_URL` as a reference to the Postgres service
   (`${{Postgres.DATABASE_URL}}`). Railway issues a bare `postgresql://` URL;
   Relay pins the psycopg 3 driver on it automatically
   (`relay.core.storage_config.normalize_database_url`), so paste it unedited.

4. **Set the backend variables.** The image already sets `RELAY_STORAGE`,
   `RELAY_AUTH_STORE`, `RELAY_DAEMON_STORE`, `RELAY_CHAT_STORE`, `HOST`, and
   `RELAY_DATA_DIR`; `PORT` comes from Railway. Add:

   | Variable | Value | Notes |
   | --- | --- | --- |
   | `RELAY_ADMIN_TOKEN` | a long random string | Seeds the admin bearer token on first boot. The value is then persisted to the data volume (`auth/admin-token`) and the env var no longer changes it; rotate from the admin console (`POST /api/v1/admin/admin-token/reissue`). |
   | `RELAY_CORS_ALLOW_ORIGINS` | `https://app.example.com` | **Option B only.** Exact origins, comma-separated. `*` is rejected. |
   | `RELAY_CORS_ALLOW_ORIGIN_REGEX` | `https://relay-web-[a-z0-9-]+\.vercel\.app` | **Option B only**, if you want Vercel preview deployments to reach the API. |
   | `RELAY_SESSION_COOKIE_DOMAIN` | `.example.com` | **Option B only.** Shares the cookie across `app.` and `api.`. |
   | `RELAY_SESSION_COOKIE_SAMESITE` | `lax` | Default. Only set to `none` for the unrelated-domains case. |
   | `RELAY_TRUST_PROXY_HEADERS` | `1` | Trust forwarded scheme/client headers from the deployment edge. |
   | `RELAY_FORWARDED_ALLOW_IPS` | comma-separated proxy IPs/CIDRs | Required with proxy trust. Use the socket-peer addresses or networks assigned to your edge; `*` is rejected. |
   | `RELAY_STREAM_MAX_SECONDS` | `240` | **Option A only.** See [SSE through a proxy](#sse-through-a-proxy). |
   | `RELAY_LOG_LEVEL` | `INFO` | |
   | `RELAY_PUBLIC_BACKEND_URL` | `https://api.example.com` | Public backend origin used in computer connection commands. Use your Railway/custom API domain, without `/api/v1`. Required for reliable copy-out URLs behind proxies. |

   TLS terminates at Railway's edge, so the app sees plain HTTP. Enable proxy
   headers and restrict them to the edge's socket-peer IPs/CIDRs; Relay then
   marks session cookies `Secure` from `X-Forwarded-Proto`. If you cannot obtain
   a stable trusted-proxy range, leave proxy headers disabled and set
   `RELAY_FORCE_SECURE_COOKIES=1` instead.

5. **Attach a volume at `/data`.** Profile images and managed-node records are
   the operational state that does not live in Postgres, and a container
   filesystem is wiped on every deploy. Railway → service → *Volumes* → mount
   path `/data` (the image already points `RELAY_DATA_DIR` there).

6. **Generate a domain.** Service → *Settings* → *Networking* → *Generate
   Domain*, or attach `api.example.com` for Option B. This URL is what both the
   web app and every daemon will use. Set `RELAY_PUBLIC_BACKEND_URL` on the
   backend to this HTTPS origin and redeploy. For a single-domain deployment,
   use the domain serving Relay's API. This setting is independent of proxy
   header trust and prevents internal HTTP URLs from appearing in commands.

## 2. Vercel: the web UI

Create a Vercel project from the same repo with **Root Directory = `web`**.
Vercel detects Next.js and installs the npm workspace from the repo root, so
`relay-core` builds via the `prebuild` script. `web/vercel.json` supplies the
build command and response headers.

Then set environment variables for **Production, Preview, and Development**:

**Option A (proxied):**

| Variable | Value |
| --- | --- |
| `RELAY_WEB_HOST` | `proxy` |
| `RELAY_BACKEND_URL` | `https://relay-backend.up.railway.app` |
| `NEXT_PUBLIC_RELAY_BACKEND_ORIGIN` | `https://relay-backend.up.railway.app` |

`RELAY_WEB_HOST=proxy` switches the build from a static export to a Node build
whose rewrites forward `/api/*` and `/profile-images/*` to `RELAY_BACKEND_URL`.
`NEXT_PUBLIC_RELAY_BACKEND_ORIGIN` does not affect request routing — it is the
origin printed in values a human copies out of the UI (daemon start commands,
chat webhook base URLs), which must address the backend directly rather than
going through the proxy.

**Option B (direct):**

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_RELAY_API_ORIGIN` | `https://api.example.com` |

Leave `RELAY_WEB_HOST` unset: the build stays a static export and the client
calls the backend origin directly with `credentials: "include"`.

> Both are build-time values. Changing either requires a redeploy, not just a
> restart.

## 3. First run

1. **Bootstrap the admin.** With `RELAY_ADMIN_TOKEN` set on the backend:

   ```bash
   curl -X POST https://<backend>/api/v1/auth/bootstrap \
     -H 'Content-Type: application/json' \
     -d '{"token":"<RELAY_ADMIN_TOKEN>","username":"admin","password":"<password>"}'
   ```

   Then keep `RELAY_ADMIN_TOKEN` in the service variables only as the
   first-boot seed. Once the backend has booted, the token is persisted to
   the data volume (`auth/admin-token`) and that persisted value is
   authoritative — deleting or changing the env var afterwards has no effect.
   A supervisor authenticates with the persisted value (see
   [The supervisor](#the-supervisor)).

   This token is **not** only a bootstrap credential. `require_admin_session`
   accepts it as a bearer token on every admin route, so it is a standing
   admin bypass that no user account, password change, or session revocation
   affects. Treat it as a break-glass key: rotate it from the admin console
   (or `POST /api/v1/admin/admin-token/reissue`) once the first admin exists
   and whenever it leaks — env var edits alone do not revoke it.

2. **Sign in** at the Vercel URL and confirm the admin dashboard loads.

3. **Connect a computer.** Open *Computers → Connect this computer*, register
   the workspace, and copy the **Install and connect** command to that computer.
   It downloads `/computer/install.sh` from the public backend and runs it with
   the computer ID, owner ID and workspace path. Paste the node token at the
   hidden terminal prompt. Credentials are never embedded in the copied command.
   Configure `RELAY_PUBLIC_BACKEND_URL` to your public HTTPS API origin; keep
   the web build's `NEXT_PUBLIC_*` settings aligned. Loopback HTTP is supported
   for local development only.

   The installer supports macOS and Linux on x64/arm64. It downloads a SHA-256
   verified archive of compiled JavaScript, so users do not need repository
   access, Git, npm, or a compiler. If Node.js 22.19+ is missing it downloads a
   private Node.js 24 runtime from nodejs.org and checks its published SHA-256.
   It requires curl, tar, and shasum or sha256sum; run as a normal user, not root.
   Agent CLIs and their login credentials must already be installed separately.

   After checking backend registration and the workspace, the installer creates
   a per-computer LaunchAgent (macOS) or systemd user service (Linux). The service
   starts at user login and restarts after failures. Linux requires an active
   systemd user session; append `--foreground` to the copied command to run in
   the terminal instead. It does not enable system-wide startup or Linux linger.
   The installer prints the log location and stop command. Confirm that the
   computer becomes online in Relay; an accepted registration alone is not an
   online heartbeat.

   Client versions live in `~/.local/share/relay/releases/<sha256>/`, private
   runtimes in `~/.local/share/relay/runtimes/`, and a convenience launcher in
   `~/.local/bin/relay-daemon`. Services use absolute paths, so no PATH edit is
   needed to connect. Node credentials remain in the existing private
   `~/.relay/daemon-nodes/<node-id>/credentials/` storage, not service definitions.
   Re-running the command installs the current release and restarts that node's
   service; stop active agent work before updating. Existing unrelated launchers
   are preserved. For manual CLI use, add `~/.local/bin` to PATH.

   `backend/Dockerfile` builds and ships the archive automatically. For source
   deployments run `npm run build:computer` before starting the backend (also
   included in `make build-packages` and `npm run build`). The default archive is
   `backend/relay/computer/daemon.tar.gz`; `RELAY_COMPUTER_BUNDLE` can override it.
   A missing archive returns HTTP 503 with an actionable build instruction.
   Keep `/computer/install.sh` and `/computer/daemon-<sha256>.tar.gz` reachable
   without login at the API origin. Archives are immutable by digest; the script
   is not cached. This change does not publish a CDN release or alter token expiry.

## Operational notes

### Run one replica

The backend runs a background `TaskScheduler` that promotes due routines and
dispatches assigned tasks. It is not leader-elected: a second replica would
promote and dispatch the same work twice. Keep `numReplicas: 1` (as
`railway.json` sets), and scale up only after giving the scheduler a lock — or
by running extra replicas with `RELAY_TASK_SCHEDULER_ENABLED=0` and keeping
exactly one scheduler instance.

### SSE through a proxy

Thread streaming is Server-Sent Events. The backend caps a single connection at
`RELAY_STREAM_MAX_SECONDS` (default 1800) and the client reconnects with
`Last-Event-ID`, so a capped connection costs a reconnect and nothing else.

Under Option A the stream crosses Vercel's proxy, which enforces its own
duration limit. Set `RELAY_STREAM_MAX_SECONDS` *below* that limit (240 is a safe
starting point) so the server closes the stream cleanly with a resumable `done`
frame instead of the proxy cutting it mid-frame. Option B streams directly from
Railway and can keep the default.

### Cold starts and sleeping

If the Railway service is allowed to sleep, the first request after idle pays
the container start. That also stops the task scheduler while asleep, so due
routines fire late. Keep the backend always-on for any deployment where routines
matter.

### Secrets

`RELAY_ADMIN_TOKEN`, `DATABASE_URL`, and chat integration credentials belong in
the platform's variable store, never in `backend/.env` — that file is
git-ignored and is a local-development convenience only. Daemon tokens are
issued per computer by the backend and are never set as service variables.

`RELAY_ADMIN_TOKEN` deserves separate care: `require_admin_session` accepts it
as a bearer token on every admin route, ahead of any session check. The env
var only seeds the token on first boot; the value persisted to the data volume
is authoritative afterwards and grants full admin access unaffected by user
accounts, password changes, or session revocation. Rotate it from the admin
console (`POST /api/v1/admin/admin-token/reissue`) if it is ever exposed —
removing the env var does not revoke the persisted token.

### Local development is unchanged

None of these settings apply locally. With no deployment variables set, the
backend binds `127.0.0.1:8790`, issues host-only `SameSite=Lax` cookies, adds no
CORS headers, and `npm run build -w web` still produces the static export that
the backend serves at `/`. See [local-development.md](local-development.md).

## Environment variable reference

**Backend (Railway)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `BACKEND_PORT` | `8790` | Listen port; Railway injects `PORT`. `BACKEND_PORT` wins if both are set. |
| `HOST` / `BACKEND_HOST` | `127.0.0.1` | Listen interface; the image sets `0.0.0.0`. |
| `DATABASE_URL` / `RELAY_DATABASE_URL` | — | Postgres URL. Bare `postgres://` and `postgresql://` are normalized to psycopg 3. |
| `RELAY_PUBLIC_BACKEND_URL` | request base URL | Public HTTPS API origin for enrollment/reconnect commands and daemon environment. No path, credentials, query, or fragment. HTTP allowed only for loopback development. |
| `RELAY_CORS_ALLOW_ORIGINS` | unset | Exact browser origins allowed to send credentials. |
| `RELAY_CORS_ALLOW_ORIGIN_REGEX` | unset | Anchored origin pattern for preview deployments. |
| `RELAY_SESSION_COOKIE_DOMAIN` | unset (host-only) | Cookie `Domain`, e.g. `.example.com`. |
| `RELAY_SESSION_COOKIE_SAMESITE` | `lax` | `lax`, `strict`, or `none`. `none` forces `Secure`. |
| `RELAY_FORCE_SECURE_COOKIES` | `0` | Mark cookies `Secure` regardless of request scheme. |
| `RELAY_TRUST_PROXY_HEADERS` | `0` | Honor trusted `X-Forwarded-Proto`/`X-Forwarded-For` values. |
| `RELAY_FORWARDED_ALLOW_IPS` | unset | Required comma-separated IP/CIDR allowlist when proxy headers are enabled; `*` is rejected. |
| `RELAY_MAX_JSON_BODY_BYTES` | `4194304` | Maximum JSON request body size before a `413` response. |
| `RELAY_STREAM_MAX_SECONDS` | `1800` | Cap on one SSE connection. |
| `RELAY_ADMIN_TOKEN` | unset | One-time admin bootstrap token. |
| `RELAY_DATA_DIR` | `.relay` | Non-Postgres operational state; `/data` in the image. |

**Web (Vercel)**

| Variable | Default | Purpose |
| --- | --- | --- |
| `RELAY_WEB_HOST` | unset (static export) | `proxy` builds a Node app that rewrites `/api` to the backend. |
| `RELAY_BACKEND_URL` | `http://127.0.0.1:8790` | Proxy target for `RELAY_WEB_HOST=proxy` and for `next dev`. |
| `NEXT_PUBLIC_RELAY_API_ORIGIN` | unset (same-origin) | Backend origin the browser calls directly. |
| `NEXT_PUBLIC_RELAY_BACKEND_ORIGIN` | unset | Backend origin shown in copy-out values under proxied mode. |
