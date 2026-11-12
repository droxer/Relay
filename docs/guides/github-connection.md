# GitHub issue import and the legacy Account connection

GitHub issue imports support public repositories anonymously and private
repositories through a selected [Connection](connections.md). The Connection's
GitHub account must have access to the repository.

To import issues:

1. Open Tasks or a Project's task board and select **Import GitHub issues**.
2. For a private repository, choose a connected **GitHub account**. Connect or
   reconnect an account in **Settings → Connections** if needed. Leave
   **Public repositories (no account)** selected for anonymous public reads.
3. Enter `owner/repository` or its GitHub URL.
4. Load issues, select the ones to import, and choose Import.

Relay validates Connection ownership and availability for both preview and
import, using the backend-held credential. It checks access to the selected
repository through GitHub. Credentials never reach the browser or Computer.
Changing the selected account requires loading a new preview. Imports create
ordinary Tasks; they do not grant those Tasks ongoing access to GitHub.
Raw access tokens are rejected. Anonymous reads still require public visibility.

The legacy Account GitHub App installation flow remains disabled. The
`RELAY_GITHUB_*` settings do not enable it and are ignored at startup. Its
connection and authorization callback endpoints answer
`501 github_connection_coming_soon` to a signed-in caller. Use the OAuth App
configuration in [Connections](connections.md) for the supported flow.

Existing database migrations and encrypted credential storage remain compatible.
The authenticated `DELETE /api/v1/account/github` endpoint still removes an
Account's previously saved connection and unfinished authorization state.
