# Waitlist Design

Status: implemented (2026-10-15); revised 2026-10-18 — see
[Revision: admin invitations](#revision-admin-invitations-2026-10-18)

## Problem

Relay has no self-serve way in. Accounts are created by an admin
(`POST /admin/accounts`) or by the one-time bootstrap token, and the public
deployment at `get-relay.cc` shows only a sign-in screen. A person who hears
about Relay and wants to try it has nowhere to say so. We want them to leave
their details in a few seconds, and we want admins to decide who gets in and
when, without opening public sign-up.

## Goals

- A visitor can join the waitlist from the public web UI with no account.
- An admin can see the queue, invite people from it, and decline or erase
  entries.
- An invited person turns their invite into a normal Account + User in one
  step, through the same password policy and handle rules as every other path.
- The public endpoint can't be used to enumerate emails, spam the queue, or
  turn into an unbounded write path.

## Non-goals (v1)

- Public sign-up. The waitlist is a gate, not an alternative way to register.
- Showing a queue position, referral codes, or "skip the line" mechanics.
  These invite gaming and need anti-abuse work we don't have yet.
- Email as a hard dependency. Invites go out through Cloudflare Email Service
  when it is configured. Without it, the copy-the-link fallback still works
  (see [Invite delivery](#invite-delivery)).
- Marketing or newsletter mail to the list. Only transactional mail (invite,
  confirmation) is sent.
- Multi-org / tenant routing of entries.

## Domain language

Add to `CONTEXT.md`:

**Waitlist Entry**:
A person's request to try Relay, keyed by a normalized email. It is not a User
and owns nothing; an accepted invite creates the User and Account and links
them to the entry (`accountId`).
_Avoid_: Lead, Signup, Applicant, Pending user

**Invite**:
A single-use, expiring credential issued to one Waitlist Entry. Redeeming it
creates an Account. Only its SHA-256 hash is stored.
_Avoid_: Invitation code, access key

## Lifecycle

```text
            join (public)              invite (admin)            accept (invitee)
  (none) ───────────────▶ waiting ───────────────────▶ invited ─────────────────▶ joined
                            │  ▲                        │
                 decline    │  └──── re-invite ─────────┤ expiry (derived, not a status)
                            ▼        (new token)        │
                         declined ◀──── decline ────────┘

  erase (admin, any status) → row deleted
```

- `waiting`: the default after joining. Joining again with the same email is a
  no-op that refreshes `updatedAt` and keeps the original `createdAt`, so
  nobody loses their place in line by resubmitting.
- `invited`: an invite exists. Expiry is derived from `inviteExpiresAt`, not
  stored as a status, so no background sweep is needed. Re-inviting rotates the
  token, which invalidates the old link.
- `joined`: terminal. `accountId` points at the created Account.
- `declined`: the admin said no. The public endpoint still answers as if
  joining succeeded (see [Abuse and privacy](#abuse-and-privacy)) and doesn't
  reopen the entry.
- Erase is a hard delete, for data-subject requests. It is separate from
  decline because a declined row is what stops the same person from requeueing.

## Data model

New table, created by migration `20261016_0096_waitlist_entries`. Waitlist
entries aren't sessions or tasks, so they don't go through the event log. This
is a plain row store like `org_settings`, behind a protocol in
`backend/relay/persistence/account/waitlist.py`.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `email` | text not null | trimmed and lowercased; **unique** |
| `name` | text null | ≤ 120 chars |
| `company` | text null | ≤ 120 chars |
| `role` | text null | ≤ 80 chars, free text |
| `use_case` | text null | ≤ 1000 chars ("What would you hand off to an agent?") |
| `source` | text null | `utm_source`/referrer host, ≤ 120 chars |
| `locale` | text null | `en` or `zh-CN`, used for invite copy |
| `status` | text not null | `waiting` / `invited` / `joined` / `declined`; check constraint |
| `invite_token_hash` | text null | SHA-256 of the current invite; unique where not null |
| `invite_expires_at` | timestamptz null | |
| `invited_at` | timestamptz null | |
| `invited_by_user_id` | uuid null → `users.id` | |
| `account_id` | uuid null → `auth_accounts.id` | set when `joined` |
| `admin_note` | text null | admin-only, ≤ 1000 chars |
| `created_at` / `updated_at` | timestamptz not null | |

Index: `(status, created_at)` for the admin queue, which is read oldest-first
within a status. No IP address is stored. Rate limiting is in memory and at the
edge (see below), so there is no reason to keep personal network data.

Auth stores: the waitlist table is database-only, like org settings, but the
account an invite creates goes through `ctx.auth_store`, so both the file and
the database auth store work. That is also why the invite is claimed and
released rather than joined to the account write in one transaction (see
accept below).

## API

All routes are under `/api/v1`. One switch gates the feature:
`RELAY_WAITLIST_ENABLED=1` on the backend mounts the routes (with
`is_waitlist_route` in `api/contract.py` as the one classifier). The web learns
it at runtime from `GET /auth/status` (`waitlistEnabled`) and
`GET /admin/settings` (`capabilities.waitlist`). Unlike chat channels, there is
no build flag, because a statically exported web UI on a Worker shouldn't need
a rebuild to open the waitlist. It's off by default, so self-hosted installs
don't grow a public write endpoint without opting in.

### Public

`POST /waitlist`

```json
{ "email": "ada@example.com", "name": "Ada", "company": "Acme", "role": "Eng lead",
  "useCase": "Triage support tickets overnight", "source": "hn", "locale": "en",
  "website": "" }
```

- Validates the email shape (`normalize_email`, ≤ 254 chars) and field
  lengths. Unknown fields are ignored.
- `website` is a honeypot. If it's non-empty, the server answers with the
  normal success response and writes nothing.
- **Always `202 {"ok": true}`** for valid input, whether the email is new,
  already waiting, invited, joined, or declined. The response never reveals
  whether an email is known. A `400` happens only for malformed input.
- Rate limited per client IP (`client_ip`, which trusts the edge header only
  when `X-Relay-Edge` verifies) with its own `AuthRateLimiter` instance
  (`RELAY_WAITLIST_RATE_LIMIT_ATTEMPTS`, default 5 per 10 minutes). A blocked
  caller gets `429` with `Retry-After`.

`POST /waitlist/invites/lookup` `{ "token" }`: the join page calls this to
prefill the form. The token rides in POST bodies only, never a path, so access
logs at the edge and the backend never record one.
For a live invite it returns `{ "email", "name", "suggestedHandle",
"expiresAt" }`. Any other token (unknown, rotated, expired, or already used)
gets one uniform `404 "This invite link is no longer valid."`. Rate limited per
IP.

`POST /waitlist/invites/accept`

```json
{ "token": "…", "handle": "ada", "password": "…" }
```

- The handle is both the login username and the `@handle`. It is normalized by
  `normalize_user_handle`, and the password is checked by `validate_password`
  (handle, name, and email as `identifiers`), both before the invite is
  touched.
- Then `claim_invite` flips the entry to `joined` and clears the token hash in
  one conditional UPDATE (`status = 'invited' AND hash = ? AND expires_at >
  now`). Of two concurrent accepts, only one gets the row back. The winner
  calls `auth_store.create_account(handle, password, role="user",
  email=entry.email, user_id=handle, display_name=entry.name)`. If that raises,
  `release_claim` restores the invite. On success `link_account` records
  `account_id`.
- `create_account` already runs `validate_password` (with the handle, name, and
  email as `identifiers`) and `normalize_user_handle`. A taken handle returns
  `409`, matching `POST /admin/users`. A failure leaves the invite live so the
  person can retry.
- On success it opens a session and sets the cookie exactly as `/auth/login`
  does, returning `{ "user": … }` decorated with `decorate_account_limits`. The
  new user lands signed in, with no second login.
- Rate limited on the same key family as login.

### Admin (`require_admin_session`)

| route | effect |
|---|---|
| `GET /admin/waitlist?status=&q=&cursor=&limit=` | The page plus `counts` per status. `q` matches email, name, or company. Default order is oldest first. |
| `POST /admin/waitlist/{id}/invite` | `waiting`/`invited`/`declined` → `invited`. Mints a new token (`secrets.token_urlsafe(32)`), stores its hash, sets a 14-day expiry (`RELAY_WAITLIST_INVITE_TTL_DAYS`), and returns `{ entry, inviteUrl }`. **This response is the only place the plaintext appears.** |
| `POST /admin/waitlist/invitations` `{ "email", "name"?, "locale"? }` | Invite an address directly (see [Revision](#revision-admin-invitations-2026-10-18)). Reuses the address's entry or creates one with source `admin-invite`, ignores the queue cap, and sends now. `409` when an Account already uses the email or the entry has joined. |
| `POST /admin/waitlist/invite-batch` `{ "count": n }` (n ≤ 50) or `{ "ids": [...] }` | Invites the oldest `n` waiting entries, or the given ids (de-duplicated). Returns one `inviteUrl` per entry with delivery `queued`; the emails are sent after the response, so a slow mail service can't push the request past the edge timeout and lose the one-time links. |
| `POST /admin/waitlist/{id}/decline` | → `declined`, clearing any live invite. |
| `PATCH /admin/waitlist/{id}` `{ "adminNote" }` | Admin note only. |
| `DELETE /admin/waitlist/{id}` | Hard delete (erasure). If the entry is `joined`, the Account is untouched; it's removed through the normal user deletion. |

Inviting a `joined` entry is refused with `409`, including while its account
is being created and before `account_id` has been linked. An unlinked claim
is not evidence that the accepting process stopped; it must never be reopened
by the normal Invite action.

## Invite delivery

Provider: **Cloudflare Email Service** (Email Sending, public beta since
2026-04-16). It runs on the same account as the zone and the web UI Worker, so
there is no new vendor. Sending to any recipient needs the Workers Paid plan,
which includes 3,000 outbound emails a month and then charges $0.35 per 1,000.

### Mailer seam

`backend/relay/notifications/mailer.py` defines a `Mailer` protocol with
`send(to, subject, text, html) -> DeliveryResult`. It has two implementations:

- `CloudflareMailer` calls the REST API,
  `POST https://api.cloudflare.com/client/v4/accounts/{account_id}/email/sending/send`
  with `Authorization: Bearer <token>`, using the backend's existing `httpx`
  dependency. It sends from the backend rather than through a Worker binding,
  because the backend owns the invite transition. Routing it through the
  `relay-web` Worker would give that Worker a second job and need a second
  secret between the two.
- `NullMailer` is used when the feature is unconfigured (self-hosted installs,
  local dev, tests). It delivers nothing and reports `skipped`.

`mailer_from_env()` picks `CloudflareMailer` only when all three settings are
present:

| env | meaning |
|---|---|
| `RELAY_MAIL_CLOUDFLARE_ACCOUNT_ID` | Cloudflare account id |
| `RELAY_MAIL_CLOUDFLARE_API_TOKEN` | API token with **only** the Email Sending send permission. This is not the deploy token. |
| `RELAY_MAIL_FROM` | for example `Relay <invites@mail.get-relay.cc>` |

If only some of the settings are present, the backend fails at startup with a
clear message. It doesn't quietly fall back to `NullMailer`, because that would
silently drop invites.

Invites are not emailed unless `RELAY_WAITLIST_INVITE_EMAIL=1`, even with a
mailer configured (password resets still use it). By default every invite is a
link: the admin copies it from the reveal panel and hands it over, the response
carries `delivery: null`, and the entry records no delivery status.

### Result mapping

The REST response groups recipients:

- `delivered` or `queued` → `sent`.
- `permanent_bounces` → `bounced`, recorded on the entry so the admin knows the
  address is dead.
- Error envelopes map by HTTP status. `429` (`10004`, throttled) and `5xx` are
  `retryable`; `401` and `403` (bad token, `not_entitled`, `sending_disabled`)
  are `misconfigured` and logged at error level.

The send has a short timeout (5 s). It never blocks or rolls back the state
transition: the entry is invited whether or not the email went out.

### What gets sent

- **Invite** (on `invite` and `invite-batch`): the subject, the `inviteUrl`,
  the expiry date, and a plain-text body plus minimal HTML, in the entry's
  `locale` (`en` / `zh-CN`). Batch sends go one recipient per request (never
  `to`/`bcc` lists, so addresses don't leak between invitees). They run
  sequentially at a bounded pace, below the account's daily quota.
- **Confirmation** ("You're on the list"): sent **only on first insert**. A
  resubmit, a honeypot hit, or a declined address sends nothing. Even so,
  someone can type a stranger's address once and trigger one email to it. That
  is why rate limits apply before the insert, and why the confirmation can be
  turned off with `RELAY_WAITLIST_CONFIRMATION_EMAIL=0` if abused.

### Columns and fallback

New columns on `waitlist_entries`: `last_delivery_status`
(`sent`/`bounced`/`failed`/`skipped`), `last_delivery_error`, and
`last_delivered_at`.

The admin invite response still returns `inviteUrl`, shown once with a copy
button, so an admin can hand-deliver a link that bounced or failed, or send
invites from an install with `NullMailer`. The admin list shows the delivery
status per row, and a **Resend** action rotates the token and sends again.

### Cloudflare setup (one time, documented in `docs/deployment-cloudflare.md`)

1. Upgrade the account to Workers Paid.
2. Onboard a sending subdomain in **Compute → Email Service → Email Sending →
   Onboard Domain**. Use `mail.get-relay.cc` rather than the apex, so sending
   reputation and SPF/DKIM/DMARC stay separate from any human mail on the apex.
   The onboarding adds the `cf-bounce` MX, SPF, DKIM, and DMARC records.
3. Create the send-only API token and set the three `RELAY_MAIL_*` values on
   the Railway backend. `deploy/config.example.env` gets an optional
   "Email" block, and `deploy/lib/railway.sh` passes the values through like
   the `RELAY_R2_*` set.
4. New accounts start with a conservative daily quota that rises with
   reputation. Invite in small batches at first.

## Web

- **Login screen.** Under the sign-in form, add "Don't have an account?
  **Request access**". It shows only when the waitlist flag is on.
- **`/waitlist`** (new route root added to `WEB_UI_ROUTE_ROOTS`). The page reuses
  the login cover layout, so the brand moment carries over. The form has email
  (required), name, company, role, a "What would you hand off?" textarea, and
  the hidden honeypot. It reads `utm_source` / `document.referrer` into
  `source`. On submit the form is replaced by a calm confirmation. Copy is
  identical for new and existing emails.
- **`/join#token=…`** (new route root `join`; the token is in the fragment,
  which browsers never send to the Worker, the edge, or the backend). It calls the invite lookup. A
  live invite shows a prefilled, read-only email plus handle and password
  fields, validated by the existing `normalizeUserHandle` and
  `passwordPolicy.ts` mirrors. A dead invite shows a short explanation and a
  link back to `/waitlist`. On success it hands off to the app as a login does.
  The token is read once and then removed from the URL with
  `history.replaceState` so it doesn't linger in history or screenshots.
- **Admin: Waitlist section.** Add a new `sec-*` rail section in `/admin`
  (addressable, per the section-rail grammar). It shows a list grouped by status
  (Waiting / Invited / Joined / Declined, like the backlog grouping) with
  search, a per-row Invite / Decline / Note / Erase menu, an "Invite next N"
  action, and the one-time invite-link reveal. While mounted, the queue polls
  every three seconds for new requests, redemptions, and background delivery
  results. Delivery status appears in the refreshed table rather than the
  one-time link reveal, whose response is only an issuance snapshot.
  The Invited group shows expiry
  and offers Re-invite. A dashboard KPI tile for "Waiting" is optional
  follow-up.
- i18n: `waitlist.*` and `admin.waitlist.*` keys in `en` and `zh-CN`.

## Abuse and privacy

- **No enumeration.** Uniform `202` on join, uniform `404` on invite lookup.
  Both run through the same code path, so timing doesn't leak either.
- **Rate limits in two layers.** Per-process limits apply in the app. In
  production, add a Cloudflare WAF rate-limiting rule for
  `POST /api/v1/waitlist` (documented in `docs/deployment-cloudflare.md` §5),
  because the in-process limiter doesn't hold across replicas.
- **Honeypot now, Turnstile later.** If spam shows up, Cloudflare Turnstile can
  be added behind `RELAY_WAITLIST_TURNSTILE_SECRET` without changing the API
  shape (one extra `turnstileToken` field).
- **Bounded growth.** Field length caps plus a unique email bound each row and
  keep the row count to one per address. A global cap on
  (`RELAY_WAITLIST_MAX_WAITING`, default 10 000) answers `503` when full.
  Admission holds the shared database resource lock through the count and
  insert, so concurrent backend replicas cannot overrun the cap.
- **Invite secrecy.** Only the hash is stored (the same rule as daemon tokens).
  Tokens are single-use, expire, and are rotated on re-invite. Accepting
  claims the invite with one conditional update before creating the account,
  so two concurrent accepts can't both win.
- **Data minimization.** No IP address, user agent, or tracking id is stored.
  Erase deletes the row. These are the only personal fields, and the admin list
  is admin-only.

## Code layout

```text
backend/relay/persistence/account/waitlist.py      # DatabaseWaitlistStore + protocol
backend/relay/accounts/waitlist.py               # join / invite / accept rules (pure-ish, store-injected)
backend/relay/api/waitlist_routes.py             # public routes
backend/relay/notifications/mailer.py            # Mailer protocol, CloudflareMailer, NullMailer, mailer_from_env
backend/relay/notifications/templates.py         # invite + confirmation copy (en, zh-CN), text + html
backend/relay/api/admin_routes.py                # or admin_waitlist_routes.py if it grows
backend/migrations/versions/20261016_0096_waitlist_entries.py
web/src/components/waitlist/WaitlistScreen.tsx
web/src/components/waitlist/JoinScreen.tsx
web/src/components/admin/waitlist/WaitlistView.tsx
web/src/lib/waitlist.ts                          # email normalization mirror, status grouping
```

`accounts/waitlist.py` is the one place that decides transitions (join,
invite, decline, accept). The routes only parse, authorize, and delegate. That
is the same split the collaboration policy uses.

## Tests

- `backend/tests/unit/test_waitlist_service.py`: transitions, resubmit keeps
  `created_at`, a declined entry stays declined on rejoin, re-invite
  invalidates the old token, an expired invite is rejected, a joined entry
  can't be invited.
- `backend/tests/api/test_waitlist_routes.py`: uniform 202 for new, known, and
  honeypot input; uniform 404 for bad, used, and expired tokens; accept creates
  the account and sets the cookie; a weak password or taken handle leaves the
  invite live; rate-limit 429; routes absent when the flag is off or under the
  file store; admin routes require an admin session.
- A concurrency test: two accepts on one token produce exactly one account.
- `backend/tests/unit/test_cloudflare_mailer.py` (with `httpx.MockTransport`,
  no network): request shape (URL, bearer header, one recipient), mapping of
  `delivered`/`queued`/`permanent_bounces`, error envelopes (`10004` →
  retryable, `10105`/`10203` → misconfigured), timeout, partial env failing at
  startup, and the absence of the API token from logs and error text.
- Service tests with a fake mailer: an invite records the delivery status, a
  failed send still leaves the entry `invited` with a usable `inviteUrl`, a
  confirmation sends only on first insert, and batch invites send one request
  per recipient.
- Web: `waitlist.test.ts` (form validation, success copy identical for both
  outcomes), `joinScreen.test.ts` (dead-invite state, token stripped from the
  URL), and admin grouping and one-time link reveal.
- `deploy/tests`: verify that `POST /api/v1/waitlist` through the edge returns
  202, and that the WAF rule is present.

## Rollout

1. Backend store, migration, service, and routes behind `RELAY_WAITLIST_ENABLED`
   (off), plus tests.
2. Mailer seam: `CloudflareMailer`, `NullMailer`, templates, delivery-status
   columns, and the deploy pass-through for `RELAY_MAIL_*`.
3. Web `/waitlist`, `/join`, the login link, and the admin section (with
   delivery status and Resend), shown when the backend reports the switch.
4. Production: Workers Paid, onboard `mail.get-relay.cc`, create the send-only
   token, set `RELAY_WAITLIST_ENABLED` and the mail env, add the WAF rule, send a test invite
   to a verified address first, then update `deploy/README.md`,
   `docs/deployment-cloudflare.md`, and `docs/api.md`.
5. Later: Turnstile if needed, a dashboard tile, and bounce handling via
   Cloudflare's suppression list API.

## Revision: admin invitations (2026-10-18)

The first version only let an admin invite someone who had asked, and only
when the public waitlist was on — on a default install there was no way to
invite anyone by email at all. The revision separates the two:

- **Only the public join is gated.** `RELAY_WAITLIST_ENABLED` now publishes
  just `POST /waitlist` (`is_waitlist_route`). The invite lookup/accept routes
  and the admin queue are always mounted: neither is an open write path —
  redeeming needs a token, and only an admin can mint one. The service is
  always built.
- **Invite by email.** `POST /admin/waitlist/invitations` takes an address,
  an optional name (the email's greeting), and a language. It goes through the
  same entry and token machinery (`WaitlistService.invite_email` →
  `store.admit_invitee` → `invite`), so one address still has one live invite,
  a re-invite still rotates it, and a joined entry is still refused. A new
  entry carries source `admin-invite`; an existing one keeps the person's own
  answers and takes the admin's name and language. The queue cap is skipped —
  it bounds the public write path, not admins. An address a live Account already
  holds (its own email or its User's) is refused with `409`: that person signs
  in or resets their password instead. Deleting a User is a soft delete, so a
  joined entry whose User is gone is reopened (`reopen_departed`) and invited
  again; a joined entry with no linked account yet stays closed, because that
  account may be being created.
- **Emailed links use the trusted origin.** The first version built the link
  on `public_web_url() or` the request's own origin and mailed it either way.
  An emailed link now uses `trusted_web_origin()` (moved to
  `core/deploy_config.py`, shared with password reset); without a configured
  origin the link is still built and shown to the admin, but never mailed, and
  its delivery reads `skipped`. `GET /admin/settings` reports
  `capabilities.inviteEmail` (mail configured and a trusted origin) so the
  console can say up front whether the invite will be emailed.
- **Stale batch sends are dropped.** A batch's emails go out after the
  response; one whose entry was re-invited, declined, accepted, or erased in
  between is no longer sent, since its link is dead.
- **Web.** The admin section is always in the rail — "Waitlist" when the
  public join is open, "Invitations" when it is not — with **Invite by email**
  as its primary action (a drawer: email, name, language) and "Invite next N"
  beside it only while people can ask. The one-time link reveal is shared with
  the other invite actions, and rows invited directly read "Invited by an
  admin" instead of "via <source>".

## Open questions

1. ~~Email provider~~: decided 2026-10-15, Cloudflare Email Service (see
   [Invite delivery](#invite-delivery)). Its Email Sending is still beta; the
   `Mailer` seam keeps a switch to another provider to one class.
2. **Auto-approval.** Should some domains (for example a partner's company
   domain) skip the queue? This could be an `org_settings` allowlist evaluated
   on join. It's deferred, but the service seam makes it a one-function
   change.
3. **Fields.** Are company, role, and use case the right questions, and should
   any be required? Fewer fields mean more sign-ups.
