# Password Reset Design

Status: implemented (2026-10-16)

> Note (2026-10-18): the file-backed accounts store this plan mentions has since been retired; accounts and reset links are database-only, and an install's old `auth/` files are imported once at boot (`backend/relay/security/auth_file_import.py`).

## Problem

A person who forgets their password has no way back in on their own. Today an
admin has to notice and fix it out of band, and there is no admin control that
sets another account's password either. Now that the backend can send
transactional email (`backend/relay/notifications/mailer.py`, built for the
waitlist), an Account with a known email address can prove control of that
address and choose a new password itself.

## Goals

- From the sign-in screen, a person can ask for a reset link by entering their
  username or email, and set a new password from that link.
- The public request endpoint can't be used to find out whether a username or
  email exists, to flood an inbox, or to run unlimited password hashing.
- A reset logs out every existing session for that Account and tells the owner
  by email that the password changed.
- A new password goes through the one password policy
  (`security/passwords.py`), with the Account's own identifiers as context.
- It works with both the file auth store and the database auth store.
- An install without mail still has a way out: an admin can generate a reset
  link and give it to the person (the same copy-the-link fallback the
  waitlist uses).

## Non-goals (v1)

- Changing your password while signed in (a "change password" form in
  Settings). It can reuse the hash-write and session-revoke steps of
  `complete_password_reset` later, but it is a separate surface.
- Email verification and a self-serve "change my email" flow. Admins already
  set emails through `PATCH /admin/users/{id}`; this design trusts that value.
- MFA, recovery codes, and security questions.
- Daemon credentials. Node tokens are separate from Account passwords, and a
  password reset leaves them alone.

## Domain language

Add to `CONTEXT.md`:

**Password Reset**:
A single-use, expiring credential issued to one Account that lets whoever
holds it set that Account's password once. Only its SHA-256 hash is stored.
Issuing a new one revokes any earlier one for the same Account.
_Avoid_: Recovery token, Reset code, Magic link (it never signs anyone in)

## Flow

```text
 sign-in screen            backend                               inbox
 ──────────────            ───────                               ─────
 "Forgot password?"
   └─ /forgot-password ─▶ POST /auth/password-reset
        (username or email)   resolve Account(s) ── none ──▶ (nothing; same 202)
                              issue token, revoke older
                              202 {"ok": true}
                              background: send reset email ───▶ link
                                                                  │
 /reset-password#token=… ◀─────────────────────────────────────────┘
   ├─ POST /auth/password-reset/lookup  → { username, expiresAt } or 404
   └─ POST /auth/password-reset/complete { token, password }
                              validate policy → claim token + set hash +
                              delete sessions (one transaction)
                              background: "password changed" email
   └─ sign-in screen with "Password updated" notice
```

## Who can reset, and where the email comes from

An Account's address is `auth_accounts.email`, or, if that is empty, the
linked `users.email` (the file store has only the first). `_recipient` in
`backend/relay/security/password_resets.py` is the one place that rule lives. An Account with neither has no self-serve reset; only the
admin path below works for it.

The request takes one field, `identifier`:

- If it contains `@`, it's treated as an email: normalized
  (`normalize_email`, shared with the waitlist) and matched case-insensitively
  against the resolved address of every Account.
- Otherwise it's a username: lowercased and matched exactly, like
  `authenticate`.

Emails aren't unique today (both columns are nullable, with no unique index).
If an email matches more than one Account, each gets its own token and its own
email, and each email names the username it resets. That's correct without a
uniqueness migration, and the person sees which login each link is for.

Silently skipped, with the same public response:

- an Account whose linked User is soft-deleted (`deleted_at` set), which
  `authenticate` already refuses;
- an Account with no resolved address;
- an Account still inside its request cooldown (see below).

## Data model

### Database store

New table `auth_password_resets`, created by migration
`20261016_0097_auth_password_resets`. Like the waitlist, this is a plain row
store, not an event log.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `account_id` | uuid not null → `auth_accounts.id` | `ON DELETE CASCADE` |
| `token_hash` | text not null | SHA-256 of the token; **unique** |
| `created_at` | timestamptz not null | |
| `expires_at` | timestamptz not null | `created_at + TTL` |
| `used_at` | timestamptz null | set when the link is redeemed or a newer one supersedes it |

Indexes: `(account_id, created_at)` for the cooldown and revoke queries, and
`expires_at` for cleanup. No IP address or user agent is stored, for the same
reason the waitlist stores none.

Issuing a link deletes rows that expired more than a day ago, so the table
needs no sweeper; a day comfortably outlives the one-hour window the hourly
cap counts.

### File store

The file auth store keeps the same records in
`<auth dir>/password-resets.json` (mode 0600), read and written under the auth
store's lock, with the same fields in camelCase. Every file-auth mutation
(including preference updates and session migration/cleanup) takes that same
shared lock, so a concurrent stale write cannot undo a reset.

### Store (`backend/relay/security/password_resets.py`)

`auth.py` is already large, so the records live in their own module, with one
class per auth store (`FilePasswordResetStore`, `DatabasePasswordResetStore`,
picked by `password_reset_store_for`). Only the table definition sits in
`auth.py`, beside the tables it references.

```python
def accounts_for(self, identifier: str) -> list[ResetAccount]
def account_for_user(self, user_id: str) -> ResetAccount | None   # admin path
def issue(self, account_id, token_hash, *, now, expires_at, throttle) -> bool
    # False while throttled; otherwise spends open links and stores this one
def peek(self, token_hash, *, now) -> LiveReset | None              # no claim
def complete(self, token_hash, password, *, now) -> ResetAccount
    # claim + validate + set hash + spend siblings + delete sessions, atomically
```

In the database store, `complete` runs in one `store_transaction`:

1. Find the live row (unused, unexpired, Account's User not deleted), lock its
   Account with `SELECT … FOR UPDATE`, and recheck the live row after acquiring
   that lock. Issuance uses the same Account-before-reset lock order. Then
   `UPDATE … SET used_at = :now WHERE id = :id AND used_at IS NULL`. Zero rows
   means a concurrent redemption won, and the method raises.
2. `validate_password(password, identifiers=(username, user_id, display_name,
   email))`. A policy failure raises, and the transaction rolls back, which
   un-claims the token. A weak password therefore doesn't burn the link.
3. Update `auth_accounts.password_hash` and `updated_at`.
4. Spend the Account's other open links.
5. `DELETE FROM auth_sessions WHERE account_id = :id`.

Unlike the waitlist accept path, the token and the password live in the same
store, so claim-and-write is one transaction. No claim/release dance is
needed.

## API

All routes are under `/api/v1`, public, and classified as auth routes
alongside `/auth/login`.

### `POST /auth/password-reset`

```json
{ "identifier": "ada@example.com", "locale": "en" }
```

- **Always `202 {"ok": true}`** for well-formed input, whether zero, one, or
  several Accounts matched. `400` only for a missing or oversized identifier
  (> 254 chars).
- Lookup, token issuing, and the send all run in a FastAPI `BackgroundTasks`
  job after the response, the same way the waitlist sends its confirmation
  email. That way neither the database lookup nor mail latency can reveal
  whether an Account exists.
- `locale` only picks the email language when the Account's own `language`
  preference is unset.

### `POST /auth/password-reset/lookup`

```json
{ "token": "…" }
→ 200 { "username": "ada", "expiresAt": "2026-10-16T12:30:00Z" }
→ 404 { "detail": "This reset link is invalid or has expired." }
```

Lets the page say "Choose a new password for **@ada**" and pass the username
to the client-side password policy as a context word. It returns only the
username, which the email already showed the holder. Every dead token
(unknown, used, revoked, expired, or deleted Account) gets the same `404`.

### `POST /auth/password-reset/complete`

```json
{ "token": "…", "password": "…" }
→ 200 { "ok": true, "username": "ada" }
→ 400 { "detail": "<password policy message>" }   # token stays usable
→ 404 same as lookup
```

It isn't gated on mail (nor is `lookup`): an admin-issued link has to work on
an install that cannot send email. It doesn't sign the person in. The page sends them to the sign-in screen with
the username filled in. Keeping `/auth/login` as the only route that sets a
session cookie means a reset link never works as a login link, and any future
second factor applies here automatically.

After success, a background task sends the "your password was changed" email
to the same resolved address.

### Admin fallback: `POST /admin/users/{id}/password-reset`

Admin session required. It issues a reset for that user's Account, skips the
cooldown, and returns `{ "url": "…", "expiresAt": "…", "delivery": "sent" |
"skipped" | "failed" | "bounced" }`. When the mailer is configured and the
Account has an address, it emails the link too. The URL is always returned,
so on a `NullMailer` install the admin copies it to the person directly. This
mirrors the waitlist's invite fallback and also gives Accounts with no email a
way back in.

## Token and link

- 32 random bytes from `secrets.token_urlsafe`, stored as SHA-256 only (same
  as session tokens and invites).
- TTL: `RELAY_PASSWORD_RESET_TTL_MINUTES`, default **30**, bounded to 5–1440.
  Admin-issued links use the same TTL.
- Link: `{web_origin}/reset-password#token=…`, built with the same
  `public_web_url() or backend_base_url(request)` origin as `invite_url`. The
  token goes in the URL fragment, so no server, Worker, edge, or access log
  ever receives it, and it never leaks through `Referer`.
- After reading the fragment, the reset page clears it with
  `history.replaceState`, so the token doesn't stay in browser history or get
  copied along with the URL.

## Abuse and privacy

| Threat | Control |
|---|---|
| Account enumeration through the response | Uniform `202`; all work happens after the response; one `404` for every dead token |
| Account enumeration through timing | Lookup and send run in a background task; the request handler does constant work |
| Inbox flooding / mail cost | Per-Account cooldown kept in the store (default one request per 60 s and at most 5 per hour, `RELAY_PASSWORD_RESET_COOLDOWN_SECONDS`), so it holds across replicas |
| Request spraying | New in-process `password_reset_rate_limiter` keyed by client IP (`client_ip`); edge rate limiting covers multi-replica deployments, as with login. Not keyed by identifier: anyone could spend that bucket on a victim's username and lock them out |
| Forged `Host` header | An emailed link's origin is `RELAY_PUBLIC_WEB_URL` or `RELAY_PUBLIC_BACKEND_URL` only (`trusted_web_origin`); with neither set, self-serve reset is off. Otherwise a request with `Host: evil.example` would mail the victim a genuine email whose link carries a live token to the attacker's site |
| One address, many accounts | A single request reaches at most three Accounts |
| Concurrent requests | `issue` locks the Account row before the throttle check, so two racing requests cannot both pass it and leave two live links |
| Brute-forcing tokens | 256-bit tokens; `lookup` and `complete` share the IP-keyed auth limiter, which also caps PBKDF2 work |
| Stolen session survives the reset | `complete` deletes every `auth_sessions` row for the Account |
| Silent takeover | "Password changed" email to the owner, with a "contact your admin if this wasn't you" line |
| An older link still works | Each new request revokes older links; completion revokes the rest |
| Weak new password | `validate_password` with Account identifiers, mirrored client-side by `passwordPolicy.ts` (minus the blocklist) |

Logging: log `password reset issued`, `completed`, and `rejected` with the
Account id and outcome only. Never log the token, the identifier as typed, or
the email address.

## Feature switch

There's no new environment flag. Self-serve reset is available exactly when
the mailer is configured (`not isinstance(mailer, NullMailer)`) and a public
origin is configured to link to (see the forged-`Host` row above). Offering a
"Forgot password?" link that can never deliver would be a dead control.

- `app.py` builds the mailer once with `mailer_from_env()` and shares it
  between the waitlist service and the reset service, instead of building it
  inside `waitlist_service_from_env`.
- `GET /auth/status` adds `"passwordResetEnabled": bool`, and the sign-in
  screen shows the link only when it's `true` (the same pattern as
  `waitlistEnabled`).
- When mail isn't configured, `POST /auth/password-reset` answers `404`, like
  an unmounted route. `lookup`, `complete`, and the admin route always work.
- A partial `RELAY_MAIL_*` set now fails startup even with the waitlist off,
  since the mailer is built for every install.

## Email

Add two messages to `notifications/templates.py`, in `en` and `zh-CN`, using
the existing plain-text-first and escaped-HTML pattern:

- **Reset** — subject "Reset your Relay password"; it names the username
  ("for @ada"), contains the action link, says when it expires ("expires in 30
  minutes"), and ends with "If you didn't ask for this, ignore this email —
  your password won't change."
- **Changed** — subject "Your Relay password was changed"; it gives the time
  in UTC and says "If this wasn't you, contact your Relay admin." It has no
  link, so it can't be used for phishing look-alikes.

The language comes from the Account's `language` preference, then the
request's `locale`, then `en`.

## Web

- `LoginScreen.tsx`: a "Forgot password?" `PublicLink` to `/forgot-password`
  under the password field, shown when `passwordResetEnabled === true`.
- `/forgot-password`: a single "Username or email" field. After submitting,
  the form is replaced by the same message whatever the result: "If an
  account matches, we've sent a reset link to its email. The link expires in
  30 minutes." Below it are a link back to sign in and a "Didn't get it? Ask
  your admin" hint.
- `/reset-password`: reads and clears the fragment, then calls `lookup`.
  - Dead token: shows "This link is invalid or has expired" and a button to
    request a new one.
  - Live token: shows "New password" and "Confirm password" fields, the
    `passwordPolicy.ts` checks with the username as context, and Submit. A
    `400` from the server shows its policy message inline.
  - Success: goes to the sign-in screen with the username filled in and a
    "Password updated — sign in with your new password" notice.
- Both pages are public routes in the landing/auth chunk, not in `App.tsx`
  (see the entry-split boundary in AGENTS.md). They're registered for the
  static export and the backend web catch-all the same way `/join` is.
- Admin: a **Password** section in the user edit drawer (`UserPasswordReset`)
  with a "Create reset link" button. It shows the returned link with a copy
  button, the delivery outcome, and the expiry. The drawer exists only under
  the database auth store (`capabilities.userEdits`); on a file-store install
  the admin route works but has no UI yet.
- New i18n keys under `passwordReset.*` in both locales.

## Implementation slices

1. **Store and service.** Migration `0097`, store methods on both auth stores,
   and `backend/relay/accounts/password_reset.py` (issue/peek/complete,
   cooldown, sending). Unit tests run against both stores.
2. **Routes and templates.** The three public routes, the admin route, the
   `auth/status` flag, shared mailer wiring, and both templates. API tests.
3. **Web.** The two pages, the login link, the admin action, i18n, and an e2e
   spec for the request → lookup → complete path with the API mocked.
4. **Docs.** The `CONTEXT.md` term, `docs/api.md`, and the new env vars in
   AGENTS.md's command list.

## Tests

- Uniform `202` for unknown, known, soft-deleted, no-email, and in-cooldown
  identifiers, and `send` is called only for the eligible ones.
- An email matching two Accounts issues two tokens and sends two emails, each
  naming its own username.
- A token is single-use: a second `complete` gets `404`. Concurrent completes
  succeed exactly once (database store).
- Expired, revoked (a newer request was issued), and unknown tokens all give
  the identical `404` body.
- A policy failure returns `400` and leaves the token usable. Then a valid
  password succeeds.
- Completion deletes all of the Account's sessions; the old cookie gets `401`
  on `/auth/me`; login works with the new password and fails with the old one.
- The cooldown holds across two store instances on one database.
- The "password changed" email is sent after completion, and a mailer
  `failed`/`skipped` result never fails the request.
- With `NullMailer`, `passwordResetEnabled` is `false` and the public route
  answers `404`. The admin route still returns a working URL.
- The token never appears in log output (capture loguru during a full flow).

## Open questions

1. **Email uniqueness.** Should we add a unique index on
   `lower(auth_accounts.email)` and resolve to one Account? This design works
   without one, but sending one email per matching Account is a workaround for
   data that's ambiguous today.
2. **Sign in after reset?** This design says no (see `complete`). If the extra
   step bothers people, `complete` could set the session cookie. That's a
   small change, but then a reset link effectively works as a login link.
3. **Admin accounts.** Should accounts with the `admin` role be self-serve
   resettable, or admin-path only? Allowing it matches common practice. The
   "changed" notification is the safeguard.
