# Accounts and first run

## Invitations and waitlist

An administrator can invite an address from the Admin console on every install.
Invitations use a single-use link; the recipient chooses a password and signs in.
The public request-access form is optional: `RELAY_WAITLIST_ENABLED=1` enables
`POST /api/v1/waitlist`. It does not enable unrestricted sign-up.

By default, an administrator copies invitation links. To send them by email,
configure all three `RELAY_MAIL_*` variables and set
`RELAY_WAITLIST_INVITE_EMAIL=1`. The hosted deploy enables invitation email unless
explicitly disabled. A trusted public web origin must be configured for emailed
links. See [Cloudflare deployment](deployment-cloudflare.md#10-transactional-email-waitlist-invites-and-password-resets-optional)
for mail setup; the [deployment script reference](../../deploy/README.md) covers
hosted configuration.

Disabling public requests leaves the admin invitation workflow available.
`GET /api/v1/auth/status` reports `waitlistEnabled`; clients use that runtime
setting. Public join requests return the same accepted response for new and
known addresses.

## Password reset

Self-service reset is available when mail and a trusted public origin are
configured. `GET /api/v1/auth/status` reports `passwordResetEnabled`. A person
requests a link from the sign-in screen, opens it, and chooses a new password.
The request returns the same response whether an account matches or not.

An administrator can also generate a reset link through
`POST /api/v1/admin/users/{id}/password-reset` and give it to the person; this
works without email. Completing a reset invalidates existing login sessions and
requires a fresh sign-in. It leaves Computer credentials unchanged.

Invitation and reset tokens are carried in URL fragments and submitted in POST
bodies. Storage retains only their hashes. Keep the links private; never put
these tokens in logs or query strings.

## First run

The onboarding panel guides a User through three real prerequisites:

1. Connect a Computer with a ready Agent Runtime.
2. Make a Logical Agent available on that Computer.
3. Complete an agent run.

Progress is derived from Computers, Agents, and Threads. Only the User's choices
such as dismissing the panel or closing a card are stored in the Account's
`onboarding` preference through `PATCH /api/v1/auth/preferences`.

For connection and runtime problems, start with
[personal-computer setup troubleshooting](../local-development.md#personal-computer-setup-troubleshooting).
The implementation lives in `web/src/lib/onboarding.ts`,
`web/src/components/onboarding/`, and `backend/relay/security/onboarding.py`.

## Reference

The [API reference](../api.md) owns request/response details. Account, invitation,
and reset behavior is covered by `backend/tests/api/` and `backend/tests/unit/`;
web onboarding behavior is covered by `web/tests/`.
