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
Reassignment commits the roster update and a `thread.project_manager_assigned`
event together. That event changes the current Thread owner and joins the new
Agent without rewriting past runs or removing historical participants. The
composer reconciles saved targets against the current role holder after its
Agent directory loads. Stale targets in the role's canonical conversation return
409 instead of silently dispatching the former manager.

The role reads fresh Project records, explains progress and the backlog, and
stages Task changes. An owner reviews the proposal in the Thread, edits individual
fields, selects operations, and applies or dismisses it. New Tasks enter backlog.
Apply uses normal domain validation, revision checks, idempotency and an atomic
transaction. It cannot silently start work, accept an outcome or reconcile a run.

## Capability resolution

`manager_run_context` resolves the enabled Project roster role for the selected
Logical Agent. A conversation round pins that Project/Agent/binding revision in
its run manifest. Manager capability does not depend on the canonical Thread ID;
addressing the role holder in another Project conversation receives the same
scoped tools, and proposals appear in the conversation that produced them.
Project setup drafts keep their separate setup workflow. The canonical manager
Thread is the role's default conversation and navigation destination.

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
Concurrent installers use an exclusive installation lock with an owner PID;
a dead owner's lock is reclaimed, while an active installer remains exclusive.
An unowned lock abandoned before its owner file was written becomes reclaimable
after two minutes. Configuration conflicts preserve user changes and report the
affected runtime. Other runtimes are still configured.

Setup reconciles beside command polling: transient failures retry with backoff,
ready configurations are rechecked every 15 minutes, and newly ready runtimes
trigger immediate reconciliation. The daemon records `mcp-status.json` in its
private state directory; `relay-daemon doctor` reports ready, retrying, blocked or
stale status. Revocation stays blocked until explicit reconnection. Managed
launches verify their own runtime configuration before execution and fail closed
on configuration conflicts.

The installed process is the bundled Node executable and `relay-mcp.js`, with
`--config <private-config.json>`. `relay mcp --config <path>` is also available
through the installed Relay control CLI. The config contains a backend URL and
a token-file path. Neither runtime config nor Project workspace contains the token.

## Token authentication

The MCP server invokes Relay's JSON API with `Authorization: Bearer <MCP token>`.
It does not forward the daemon credential or use a browser cookie. The backend
stores only a SHA-256 digest; issuance returns plaintext once with `no-store`.

For standalone local CLI sessions, an enrolled Computer obtains a 90-day token
using its existing daemon credential.
That token can access only its owner's Projects on that Computer, and stops
working if the Computer is retired or ownership changes. Tokens can be revoked
individually. Reconciliation checks the saved credential with the backend and
renews it within seven days of expiry, including recovery after expiry. Renewal
revokes the old token and issues its replacement atomically. Existing server
processes read the token file for each call, so rotation needs no runtime restart.
A revoked or unknown credential is never automatically replaced. After checking
the reason, explicit reconnection removes only that Computer's
`credentials/mcp.token` and restarts its daemon; enrollment is the authority to
request a fresh credential.

Owners can also issue a 90-day token restricted to an explicit list of owned
Project IDs using `POST /api/v1/mcp/tokens`. Save the returned token in a private
file (mode `0600`), outside the Project, and point a private server config at it.
List token metadata with `GET /api/v1/mcp/tokens`; revoke with
`DELETE /api/v1/mcp/tokens/{id}`. Metadata never returns the token or its hash.

## Managed run credentials

Relay-managed native processes receive daemon-owned `RELAY_MCP_RUN_CONTEXT`
metadata in their execution environment. It contains a Project ID and a path to
the run's host transport, never a credential. Codex configuration explicitly
forwards that environment variable, and Claude configuration expands it into the
MCP child's environment. Kimi and OpenCode inherit the process environment; Pi's
extension spawns its MCP process with the same environment. Before each managed
launch, Relay checks its owned runtime configuration independently of standalone
token health. Revoking a standalone token does not substitute a new broad grant
or prevent a separately authorized managed run from using its own scope.

An installed Relay MCP server in a managed process uses only that run context.
Other Projects/backends are refused. Non-manager managed runs receive a disabled
context; none of these processes fall back to the standalone Computer credential.
The daemon proxy lazily obtains a command-bound MCP token and calls the same
MCP API using that token. Isolated runtimes use their host/guest transport to the
same proxy. The run token stays in daemon memory, outside the workspace and
Agent environment. It is limited to the admitted Project and stops authenticating
when the run ends, with a maximum lifetime of 24 hours. Proposals retain the
actual Logical Agent, run and producing Thread. Existing admitted runs retain
their pinned context when a role is reassigned; subsequent rounds resolve the new
holder. No backend process executes an Agent.

These are tool-request scope guarantees. Native runtimes share the owner's OS
account; host filesystem isolation requires a sandbox rather than file modes
alone. Configuration forwarding is checked against the runtime sources:
[Codex](https://github.com/openai/codex/blob/main/codex-rs/rmcp-client/src/utils.rs),
[Claude](https://code.claude.com/docs/en/mcp),
[Kimi](https://github.com/MoonshotAI/kimi-code/blob/main/packages/agent-core-v2/src/mcpCore/client-stdio.ts),
[OpenCode](https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/mcp/index.ts).

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

See [architecture-fix verification](testing/project-manager-architecture-fixes.md)
and [the initial feature evidence](testing/project-manager.tdd.md). Migrations 0113
(proposals) and 0114 (MCP token digests) must run before serving this version.
Rebuild and install the Computer client advertising `project-manager-mcp`; older
clients are refused for manager runs until updated. Native provider
sessions are not simulated by the browser fixtures; actual stdio/API transport,
configuration preservation and authorization have separate tests.
