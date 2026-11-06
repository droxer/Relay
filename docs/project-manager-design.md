# Project Manager Agent and Relay MCP

The Project Manager is an ordinary Logical Agent that holds one responsibility
in a Project: the `projectManager` flag on its roster entry. The flag sits
beside the member's `role`, which stays one of the Agent Roles (planner,
implementer, reviewer, tester, fixer), so a reviewer can also manage the
Project, and handing the responsibility over never changes anyone's role. At
most one member holds it. The roster is the only record; the Project's
`managerAgentId` is derived from it on read. A legacy member stored with
`role: "project_manager"` reads back as a planner holding the flag
(`core/project_roles.py`).

Only the owner assigns the role. A new Project takes the owner's
`managerAgentId`, else its lead when the lead is eligible; `null` leaves it
open. The creation drawer preselects the oldest eligible Agent and sends that
choice explicitly. No read, startup repair or conversation assigns a manager
afterwards, and nobody joins the roster except the Agent the owner chose.

The manager does its job through the work it is given: the Tasks and
Automations it runs in the Project. The Dashboard only names it, as one line
above the Project's numbers (`ProjectManagerLine`) — the Agent, its role,
whether it can work, and a way to the Agents tab where the role changes hands.
It is drawn from the project and agents the page already loaded, and offers no
chat. There is no manager chat drawer, dedicated message route or alternate
Relay persona.

A Project may still have a manager Thread from earlier releases (and
`POST /projects/{id}/manager/conversation` can still start one). It is an
ordinary Project Conversation that no Agent owns: each message goes to whoever
it addresses, and the composer defaults to the current holder. Reassigning the
role changes only the roster. It writes nothing to any Thread, and the former
holder stays an ordinary Agent that can still be addressed, without the
manager tools.

The role reads fresh Project records, explains progress and the backlog, and
stages Task changes. An owner reviews the proposal in the Thread, edits individual
fields, selects operations, and applies or dismisses it. New Tasks enter backlog.
Apply uses normal domain validation, revision checks, idempotency and an atomic
transaction. It cannot silently start work, accept an outcome or reconcile a run.

## Capability resolution

`create_round_manifest` attaches the manager context
(`round_manager_context` in `core/project_roles.py`) to every round in a
Project whose pinned snapshot names an enabled holder among its assignments:
a Task run, an Automation occurrence, a Thread message, or a continuation,
alone or beside other Agents. The context pins that Project/Agent/binding
revision, and the registry hands the tools to the holder's own assignment only.
Manager capability does not depend on the Thread; proposals appear in the
Thread of the run that produced them. Project setup drafts keep their separate
setup workflow and drop the context.

Every other enabled roster member reads the Project through the same tools.
Its run carries a `project_reader` scope (`project_reader_context`), so it can
read the overview, Tasks, review evidence, activity and Threads, but never
stage changes: the run token's grant reads `access: "read"`, `tools/list`
omits `relay_propose_task_changes`, and a propose call answers 403
`project_manager_required`. Only the holder's `project_manager` scope grants
`access: "manage"`. An Agent assigned Project work without being on the roster
gets neither. Reader scopes go only to Computers advertising
`project-reader-mcp`; older ones run those Agents without the tools.

Holding the role never stops an Agent from running. On a Computer that does not
advertise `project-manager-mcp`, the holder runs without the tools and the
manager view reports `project_manager_update_required` to the owner.

`GET /projects/{id}/manager` only reads. It reports the holder, candidates,
availability reason, the manager Thread (absent if it was deleted; opening the
conversation starts a new one) and proposals.

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

The local bridge forwards MCP messages to `POST /api/v1/mcp` with
`Authorization: Bearer <MCP token>`.
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
Other Projects/backends are refused. Runs outside the roster receive a disabled
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

The dedicated `backend/relay/mcp/` module owns the catalog, schemas, MCP protocol,
authorization and dispatch. It uses the official MCP Python SDK with stateless
JSON Streamable HTTP at `POST /api/v1/mcp`, inside the existing backend deployment
and lifespan. It calls existing Project application operations directly; no
additional service, port or Python installation on Computers is required.

The local Node process handles newline stdio framing and authenticated HTTP
forwarding. It forwards messages and negotiated protocol metadata without a
second catalog or tool dispatch table. Managed messages travel through the
existing daemon transport with a daemon-held run token. Pi discovers tools from
the hosted catalog.

Every HTTP request authenticates independently, including initialization and
notifications. Cookies do not grant MCP authority. Request-local grants remain
isolated across concurrent calls. Origin checks use the backend policy; all
responses carry `Cache-Control: no-store`. Authenticated GET/DELETE return 405
because this endpoint offers no server event stream or resumable session.
Requests are bounded to 128 KiB and tool responses to 1 MiB, including both text
and structured content. HTTP redirects are refused; errors exclude credentials
and internal exception details. Backend URLs require HTTPS, except loopback HTTP
for local development. Existing `/mcp/projects` JSON routes remain compatibility
adapters over the same Python operations for older clients and workspace helpers.

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
again for every call. A roster member's run token is read-only; only the
Project Manager's run (or an owner/Computer token) may call
`relay_propose_task_changes`. There is no Apply, acceptance, run-start, or reconciliation
MCP tool. Browser owner authentication is required for Apply.

## Verification and rollout

See [architecture-fix verification](testing/project-manager-architecture-fixes.md)
and [the initial feature evidence](testing/project-manager.tdd.md). Migrations 0113
(proposals), 0114 (Connections) and 0115 (MCP token digests) must run before serving this version.
Rebuild and install the Computer client advertising `project-manager-mcp`; older
clients run the manager without its tools until updated. Native provider
sessions are not simulated by the browser fixtures; actual stdio/API transport,
configuration preservation and authorization have separate tests.

The role-as-flag model needs no migration: stored rosters with the legacy
`project_manager` role are upgraded when read, and the retired
`managerInitialized` field is dropped from responses. Projects the removed
startup backfill never reached simply show the role as unassigned until the
owner picks a holder. `backend/tests/api/test_project_manager_api.py` covers the
flag, handover without Thread rewrites, read-only views, multi-Agent rounds and
older Computers.
