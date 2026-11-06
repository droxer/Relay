# Project Manager Agent and Relay MCP

The Project Manager is an actual Logical Agent holding the `project_manager`
role in a Project roster. The Agent retains its name, profile, global execution
role and roles in other Projects. There is one holder per Project. New Projects
select their eligible lead, or the first eligible Agent, and put that Agent in
the roster. Explicit `managerAgentId: null` leaves the role unassigned.

The Dashboard shows the Agent and its Project role. Chat opens its normal Thread;
opening it does not dispatch a run. The normal composer, transcript, permission
prompts and Agent attribution apply. There is no manager chat drawer or alternate
Relay persona. The role can be reassigned through the Project Agents editor.
The Project's canonical manager Thread and standing context survive reassignment.

The role reads fresh Project records, explains progress and the backlog, and
stages Task changes. An owner reviews the proposal in the Thread, edits individual
fields, selects operations, and applies or dismisses it. New Tasks enter backlog.
Apply uses normal domain validation, revision checks, idempotency and an atomic
transaction. It cannot silently start work, accept an outcome or reconcile a run.

## Local Agent Runtimes

After registering a local Computer (`sandboxMode: none`), the daemon installs
Relay MCP into each ready Codex, Claude Code, OpenCode, Kimi or Pi runtime.
Codex uses its TOML `mcp_servers`; Claude and Kimi use `mcpServers`; OpenCode uses
its local `mcp` configuration. Pi receives a user extension that connects to the
same stdio MCP server and registers its advertised tools. Restart an already open
Agent Runtime to load the configuration. Direct local CLI sessions can use it,
as can Relay-started local sessions.

Every installed server has a stable `relay-projects-<computer/backend hash>`
name, avoiding the permission broker's `relay` server and other Computers. The
installer preserves other servers, settings and JSONC comments. It records the
entries it owns and refuses an unowned or edited entry with the same name.
Concurrent installers are serialized by an exclusive installation lock; a
conflict is reported and retried on the next daemon start. It never resets an
Agent's configuration. An interrupted installer may leave an installation lock;
after confirming no installer is active, remove only `~/.relay/mcp/install.lock`.

The installed process is the bundled Node executable and `relay-mcp.js`, with
`--config <private-config.json>`. `relay mcp --config <path>` is also available
through the installed Relay control CLI. The config contains a backend URL and
a token-file path. Neither runtime config nor Project workspace contains the token.

## Token authentication

The MCP server invokes Relay's JSON API with `Authorization: Bearer <MCP token>`.
It does not forward the daemon credential or use a browser cookie. The backend
stores only a SHA-256 digest; issuance returns plaintext once with `no-store`.

An enrolled Computer obtains a 90-day token using its existing daemon credential.
That token can access only its owner's Projects on that Computer, and stops
working if the Computer is retired or ownership changes. Tokens can be revoked
individually. Revocation does not automatically issue a replacement. To replace
an expired or revoked local credential, deliberately remove only that Computer's
`credentials/mcp.token` and restart its daemon. Its enrollment remains the
authority to request a new credential.

Owners can also issue a 90-day token restricted to an explicit list of owned
Project IDs using `POST /api/v1/mcp/tokens`. Save the returned token in a private
file (mode `0600`), outside the Project, and point a private server config at it.
List token metadata with `GET /api/v1/mcp/tokens`; revoke with
`DELETE /api/v1/mcp/tokens/{id}`. Metadata never returns the token or its hash.

A command-bound token endpoint is available for run-scoped clients: its Project
scope is taken from the active manager command and it expires when that run
ends (with a maximum lifetime of 24 hours). Isolated runtimes retain the existing
run-scoped host/guest transport; automatic user-runtime MCP configuration is
limited to local Computers. No backend process executes an Agent.

## MCP tools

The stdio server supports legacy MCP initialization through revision 2025-11-25,
newline JSON-RPC, `tools/list`, and `tools/call`. It does not advertise the newer
stateless protocol. HTTP redirects are refused, requests and responses are
bounded, and errors do not include credentials or HTTP response bodies. Backend
URLs require HTTPS, except loopback HTTP for local development.

- `relay_list_projects`: discover token-visible Projects.
- `relay_project_overview`: current brief, roster, counts, flow and availability.
- `relay_list_tasks`, `relay_get_task`, `relay_task_review`: current Task records
  and evidence, including revisions for proposed edits.
- `relay_project_activity`, `relay_project_threads`, `relay_get_thread`: scoped
  activity and conversation history with bounded coverage.
- `relay_propose_task_changes`: stage create, update and prerequisite operations
  for owner review. Direct local proposals record MCP provenance and do not
  fabricate a daemon run. Pi adds the installed server suffix to tool names.

Every Project tool requires `projectId`; the API checks token scope and owner
again for every call. There is no Apply, acceptance, run-start, or reconciliation
MCP tool. Browser owner authentication is required for Apply.

## Verification and rollout

See [verification evidence](testing/project-manager.tdd.md). Migrations 0113
(proposals) and 0114 (MCP token digests) must run before serving this version.
Rebuild and install the Computer client for local runtime setup. Native provider
sessions are not simulated by the browser fixtures; actual stdio/API transport,
configuration preservation and authorization have separate tests.
