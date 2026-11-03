# GitHub connection — coming soon

GitHub issue imports currently support **public repositories only**. Account
connections and private repository access are coming soon.

To import public issues:

1. Open Tasks or a Project's task board and select **Import from GitHub**.
2. Enter a public repository as `owner/repository` or its GitHub URL.
3. Load issues, select the ones to import, and choose Import.

No GitHub App registration or access token is needed. Relay checks the repository's
public visibility and reads its issues anonymously. Supplied tokens are rejected;
previously saved credentials are not used.

Settings → Account and the import drawer show **GitHub connection — Coming soon**.
The `RELAY_GITHUB_*` settings do not enable it in this release and are ignored at
startup. Connection and authorization callback endpoints answer
`501 github_connection_coming_soon` to a signed-in caller.

Existing database migrations and encrypted credential storage remain compatible.
The authenticated `DELETE /api/v1/account/github` endpoint still removes an
Account's previously saved connection and unfinished authorization state.
