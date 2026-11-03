# Connect GitHub for issue imports

Users select **Connect GitHub** in Settings → Account or the issue import
drawer. GitHub asks them to authorize Relay and, if needed, install its App
on selected repositories. Relay then returns them to the page they left.
Public repositories can still be imported without connecting.

## One-time administrator setup

1. [Register a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
   owned by your organization or deployment administrator. Use a public App if
   people outside that owner need to install it.
2. Set both **Callback URL** and **Setup URL** to
   `https://YOUR-RELAY-HOST/api/v1/account/github/callback`.
3. Leave **Request user authorization (OAuth) during installation** unchecked.
   Relay starts authorization itself with state and PKCE, then sends users to
   repository selection. Leave **Redirect on update** unchecked: repository
   management happens directly on GitHub.
4. Grant repository permissions **Issues: Read-only** and **Metadata: Read-only**
   only. Request no organization or account permissions. Disable webhooks;
   imports are one-shot reads.
5. Keep expiring user access tokens enabled and create a client secret. Set all
   five backend variables below on every API replica, with the same encryption
   key. Store the secret and encryption key in your deployment secret manager.

```dotenv
RELAY_GITHUB_CLIENT_ID=YOUR_APP_CLIENT_ID
RELAY_GITHUB_CLIENT_SECRET=YOUR_APP_CLIENT_SECRET
RELAY_GITHUB_APP_SLUG=your-app-slug
RELAY_GITHUB_CALLBACK_URL=https://YOUR-RELAY-HOST/api/v1/account/github/callback
RELAY_GITHUB_ENCRYPTION_KEY=YOUR_FERNET_KEY
```

Generate the encryption key locally with
`uv run --project backend python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'`.
Keep it stable and back it up separately from the database; losing or replacing
it requires users to connect again. Do not commit these values.

Apply migration `20261103_0108` with `make backend-migrate` before restarting the
backend. Leaving every variable unset disables connection setup; partial or
invalid configuration fails startup. Local development may use an HTTP callback
on `localhost` or `127.0.0.1`; its browser host must match the Relay login cookie.

## Credential and permission boundaries

- Connections belong to login Accounts, not Projects or daemon Computers. Only
  the signed-in Account may connect, inspect its status, or disconnect.
- Authorization state expires after ten minutes, is stored hashed, and is bound
  to the login session. The verifier and pending credentials are encrypted.
  Each callback consumes its state once, including the installation callback.
- Relay checks the chosen installation with the authorized user token and
  refuses permissions beyond read-only Issues and Metadata.
- Access and refresh tokens remain encrypted in the database and never appear
  in browser API responses, task events, or daemon commands. Refreshes are
  serialized across replicas. User access is still limited by GitHub's own
  permissions and the App's installed repositories.
- Disconnect removes Relay's saved connection and unfinished authorizations.
  It leaves imported tasks intact. Users can uninstall/revoke the App under
  [GitHub settings](https://github.com/settings/installations) to remove access
  on GitHub as well.

GitHub documents the [user authorization flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[installation state](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app),
and [installation callback validation](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).
