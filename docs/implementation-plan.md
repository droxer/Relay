# Relay Technical Implementation Design V1.0

<p align="center">
  <img src="../assets/brand/relay-logo.svg" alt="Relay logo" width="360">
</p>

Enterprise AI Workforce Platform / Control Plane / Agent Runtime / Execution Plane / Memory / Governance

This document translates Relay's product and architecture strategy into an implementation blueprint. It is intentionally more concrete than the architecture deep dive: it defines deployable services, ownership boundaries, data models, runtime flows, integration contracts, and phased delivery.

Use this document after reading [system-architecture.md](system-architecture.md). The architecture document explains target system direction and strategic choices; this document explains how to build the system.

Supporting design specifications:

- [Managed Node Provisioning](managed-node-provisioning.md): desired-state
  reconciliation, provider lifecycle, secure daemon enrollment, and migration
  from the current supervisor workflow.

## Document Map

| Section | Purpose |
| :- | :- |
| 0-1 | implementation position and system boundary |
| 2 | deployable components and ownership |
| 3 | core data model and event model |
| 4 | runtime flows |
| 5 | public and internal APIs |
| 6-7 | security and observability |
| 8 | deployment topology |
| 9 | current local implementation map |
| 10-12 | decisions, open questions, and next steps |

## Architecture Decision Records

This implementation blueprint follows the current accepted ADRs:

| ADR | Implementation Impact |
| :- | :- |
| [ADR-007: Governed Enterprise Authority](adr/007-governed-enterprise-authority.md) | Tool calls, sensitive reads, writes, approvals, secrets, and audit must flow through governed Relay boundaries. |
| [ADR-008: BoxLite-First Lightweight Execution](adr/008-boxlite-lightweight-execution.md) | BoxLite is the current lightweight execution implementation, but orchestration should depend on execution-plane interfaces rather than BoxLite directly. |
| [ADR-009: Durable Control Plane Outside Sandbox](adr/009-control-plane-outside-sandbox.md) | Durable task/session state, permissions, approvals, memory, and workflow authority stay outside sandbox guest workers. |
| [ADR-010: Explicit Leases for Agent-Node Delivery](adr/010-leased-agent-node-delivery.md) | Backend-to-daemon commands use bounded, explicit leases and at-least-once delivery; only daemon-reported active work renews ownership. |
| [ADR-020: Work Outcomes](adr/020-work-outcomes.md) | Single-agent action runs use work reports on capable daemons; event-backed outcomes distinguish execution completion, agent claims, unfinished work, and human acceptance. Further verification and planning stages are listed in the ADR. |

## 0. Design Position

Relay should be implemented as a control-plane-first agent platform. Agent CLIs such as Claude Code, Codex, and Pi are execution engines, not the system of record. Relay owns task identity, authorization, workflow state, approval gates, audit trails, memory writeback, sandbox lifecycle, and tool policy.

The sandbox is an execution plane. It may contain a minimal guest worker for command execution and stream forwarding, but it must not own durable task state, approval authority, permission decisions, long-lived secrets, or organizational memory.

## 1. System Boundary

| Boundary | Inside Relay | Outside Relay |
| :- | :- | :- |
| Product workflow | Tasks, sessions, assignments, approvals, handoffs, reviews | External ticketing, CRM, Git host, CI, docs systems |
| Agent orchestration | Agent selection, prompt assembly, state transitions, retries, cancellation | Claude/Codex/Pi model internals |
| Execution | Sandbox lifecycle, command execution policy, stream capture | Host OS internals, cloud provider sandbox implementation |
| Tool access | MCP Gateway, tool registry, policy checks, audit | Individual SaaS/internal APIs |
| Memory | personal/task/project/org memory, writeback approval, retrieval index | Source documents and external knowledge stores |
| Governance | identity, tenant policy, task scope, approval service, audit logs | Enterprise IdP and SIEM consumers |

## 2. Deployable Components

This section is organized by services and runtime responsibilities. Each component should have a clear owner, persistence boundary, and trust boundary.

### 2.1 Channel Layer

Responsibilities:

- Accept work from the web app, Slack/Teams/Feishu, email, webhook, and API clients.
- Normalize user requests into Relay tasks or sessions.
- Present approval cards, review summaries, artifacts, and live status.

Initial implementation:

- Keep the web app as the developer MVP channel.
- Treat chat connectors as clients of the same task/session API, not special workflow engines.

### 2.2 Control Plane API

Responsibilities:

- Tenant, user, workspace, task, session, assignment, approval, artifact, and audit APIs.
- Authorization and policy enforcement before workflow execution.
- Durable persistence in PostgreSQL.
- Live updates through SSE or WebSocket.

Suggested implementation:

- API service in FastAPI/Python — the local control plane already runs FastAPI (`backend/relay/app.py`).
- PostgreSQL as source of truth.
- Redis for ephemeral coordination, rate limits, and fanout.
- Object storage for large artifacts.

MVP note:

Tasks and sessions live in the configured database (PostgreSQL); legacy `.relay/` session/task trees are migration inputs only.

### 2.3 Workflow Runtime

Responsibilities:

- Execute long-running task state machines.
- Persist workflow progress and resumable state.
- Coordinate approval waits, agent runs, retries, cancellation, and handoffs.
- Emit task/session events.

Suggested implementation:

- Temporal for durable workflow execution.
- A Relay Runtime library that contains workflow definitions, assignment policies, prompt assembly, routing, and event emission.
- LangGraph only where model-side planning graphs add value; do not use it as the durable system of record.

Workflow examples:

```text
engineering_fix:
  create session
  wait for human approval
  run claude implement
  run pi test/follow-up
  run codex review
  if approved: complete
  if rejected: route feedback to implementer
  if failed: retry within policy or mark blocked
```

```text
sales_followup:
  collect CRM/email/meeting context
  draft summary and CRM update
  request approval for external/customer-facing write
  execute approved writes through MCP Gateway
  write back memory
```

### 2.4 Agent Runtime

Responsibilities:

- Convert tasks and session state into agent-specific prompts.
- Select the agent and supply its role context: implementer, reviewer, tester,
  planner, or fixer.
- Launch Claude/Codex/Pi or other agents through the execution plane.
- Parse structured outputs and normalize them into Relay events.
- Enforce per-agent failure limits and handoff rules.

Implementation rules:

- Agent CLIs run inside the execution plane.
- Agent prompts must not contain long-lived secrets.
- JSON/JSONL output must be rendered into human-readable streams and captured as raw events.
- A review role may emit prose review notes; task-closing assignments use the
  same machine-readable round-result contract as other roles.
- Agent-specific command builders should stay separate from workflow policy.

### 2.5 Execution Plane

Responsibilities:

- Provide isolated execution for code, scripts, file handling, browser automation, and agent CLIs.
- Mount scoped workspaces.
- Inject short-lived credentials or generated auth files only for the active task.
- Stream stdout/stderr back to the control plane.
- Support cancellation and cleanup.

Sandbox tiers:

| Tier | Use | Runtime |
| :- | :- | :- |
| L0 | No code execution, pure retrieval or summarization | restricted worker or control-plane-only execution |
| L1 | short coding/data tasks | BoxLite |
| L2 | dependency install, batch processing, medium risk | Kubernetes Job + gVisor |
| L3 | unknown/customer-uploaded code | E2B, Kata, or equivalent high-isolation sandbox |
| L4 | long-lived development workspace | Cloud Workstations or managed developer environments |

Control-plane and guest-worker boundary:

- Run the Relay control-plane daemon outside the sandbox.
- Optionally run a minimal sandbox guest worker.
- The guest worker may execute approved commands, forward streams, report exit status, and perform local file operations.
- The guest worker must not make authorization decisions, own workflow state, store durable memory, or hold long-lived secrets.

### 2.6 MCP Gateway and Tool Layer

Responsibilities:

- Register all tools and internal system connectors.
- Authenticate users and agents.
- Enforce user permission, agent permission, task scope, and tool policy.
- Proxy calls to internal APIs.
- Audit every tool call with request metadata, decision, and result summary.

Key services:

- Tool Registry: schema, owner, version, risk level, scopes, rate limits.
- Policy Engine: checks whether a tool call is allowed for the user, agent, tenant, and task.
- Secret Broker: issues short-lived task-scoped credentials.
- MCP Gateway: exposes approved MCP servers/tools to agents through a governed interface.

Write policy:

- Low-risk reads may execute after policy checks.
- Sensitive reads require stronger scopes and audit.
- External writes, customer-visible content, production changes, payments, deletions, and high-risk internal writes require human approval unless the tenant policy explicitly allows automation.

### 2.7 Memory Plane

Responsibilities:

- Retrieve relevant personal, task, project, team, and organization memory.
- Store session outcomes, artifacts, decisions, reusable patterns, and feedback.
- Separate raw artifacts from curated memory.
- Support memory writeback review and redaction.

Suggested data stores:

- PostgreSQL for canonical memory objects and relations.
- pgvector for MVP embeddings.
- Qdrant or another vector database when vector scale demands it.
- OpenSearch for keyword and faceted retrieval.
- Object storage for large artifacts.

Memory types:

| Type | Scope | Examples |
| :- | :- | :- |
| Personal memory | user | preferences, working style, recurring tasks |
| Task memory | session/task | decisions, files changed, review feedback |
| Project memory | repo/workspace | architecture notes, conventions, known pitfalls |
| Team memory | group | playbooks, reusable workflows |
| Organization memory | tenant | policies, domain knowledge, approved procedures |

Writeback flow:

```text
session completed
extract candidate memories
classify sensitivity and scope
deduplicate against existing memory
request review when policy requires it
persist accepted memory
index for retrieval
link memory to source session/artifacts
```

### 2.8 Governance Plane

Responsibilities:

- Enforce identity, permissions, approvals, policy, retention, and audit.
- Provide tenant-level controls for allowed agents, allowed tools, network egress, data residency, and memory writeback.
- Produce compliance-ready event histories.

Core checks:

```text
user permission
agent permission
task permission
tool policy
data sensitivity
approval requirement
egress/network policy
secret scope
```

Audit events should cover:

- task/session creation
- assignment and handoff
- human decision
- sandbox creation/destruction
- command execution
- tool call request/decision/result
- secret issuance
- memory read/writeback
- artifact creation
- external write

## 3. Core Data Model

The implementation preserves an event-sourced task/session model. PostgreSQL is the source of truth in every environment without changing the conceptual model.

### 3.1 Primary Entities

| Entity | Purpose |
| :- | :- |
| Tenant | enterprise boundary and policy root |
| User | human identity from IdP |
| AgentIdentity | Claude/Codex/Pi/custom agent identity and permissions |
| Workspace | repo, project, business workspace, or mounted execution context |
| Task | durable work item |
| Session | one execution thread or handoff chain |
| Assignment | one agent role step in a session |
| Artifact | command logs, diffs, reports, plans, summaries |
| Approval | human gate and decision record |
| ToolCall | governed external/internal tool invocation |
| SandboxRun | execution-plane lifecycle record |
| MemoryObject | accepted durable memory |
| AuditEvent | immutable governance event |

### 3.2 Event Model

Use append-only events as the source of truth for task/session execution.

Suggested event families:

```text
task.created
task.updated
task.assigned
task.status
task.session_linked

session.created
session.status
assignment.planned
human.decision

sandbox.created
sandbox.ready
sandbox.destroyed

agent.started
agent.output
agent.completed
agent.failed

tool.requested
tool.allowed
tool.denied
tool.completed

artifact.created
memory.candidate_created
memory.written

session.completed
session.failed
session.cancelled
```

### 3.3 PostgreSQL Tables

Initial relational schema:

```text
tenants
users
agent_identities
workspaces
tasks
task_events
sessions
session_events
assignments
approvals
artifacts
sandbox_runs
tool_registry
tool_calls
memory_objects
memory_links
audit_events
```

Implementation rule:

Task/session event append should be transactionally paired with materialized snapshot updates. For cloud deployment, use `SELECT ... FOR UPDATE` or optimistic versioning to prevent concurrent state corruption.

## 4. Runtime Flow

### 4.1 Task Creation

```text
client request
authenticate user
authorize workspace/task creation
create task
optionally create pending session
emit task/session events
return task/session id
```

### 4.2 Assignment Approval

```text
assignment plan generated
policy engine classifies risk
if approval required:
  create approval
  notify human
  pause workflow
else:
  continue
```

### 4.3 Agent Execution

```text
workflow starts assignment
resolve task context and memory
request sandbox
prepare workspace and scoped credentials
build agent command and prompt
execute in sandbox
stream stdout/stderr
capture artifacts
parse structured output
destroy or retain sandbox according to policy
emit assignment result
route next step
```

### 4.4 Tool Call Execution

```text
agent requests tool
MCP Gateway receives call
resolve user, agent, tenant, task, and tool
evaluate policy
if approval needed: pause and request decision
if allowed: issue short-lived credential
execute tool call
record audit event and result summary
return response to agent
```

### 4.5 Session Completion

```text
final agent/review step completes
write final artifacts
extract memory candidates
request memory writeback review if required
mark session completed or failed
update task status
notify channel clients
```

## 5. API Surface

APIs should expose Relay's canonical task/session model. Channel clients, web UI, chat integrations, and automation clients should all use the same underlying APIs.

### 5.1 Control Plane API

Minimum API groups:

```text
/api/v1/tasks
/api/v1/threads
/api/v1/assignments
/api/v1/approvals
/api/v1/artifacts
/api/v1/events
/api/v1/workspace
/api/v1/tools
/api/v1/memory
/api/v1/audit
```

Execution APIs:

```text
POST /api/v1/threads
POST /api/v1/threads/{id}/assignments
POST /api/v1/threads/{id}/cancellations
POST /api/v1/approvals/{id}/decisions
GET  /api/v1/threads/{id}/events
GET  /api/v1/threads/{id}/artifacts/{artifact_id}
```

### 5.2 Internal Runtime APIs

Control plane to workflow runtime:

```text
start_workflow(session_id, workflow_type)
signal_approval(session_id, approval_id, decision)
cancel_workflow(session_id)
query_workflow(session_id)
```

Workflow runtime to execution plane:

```text
create_sandbox(spec)
prepare_workspace(sandbox_id, workspace_spec)
prepare_credentials(sandbox_id, credential_spec)
exec(sandbox_id, command_spec)
stream(sandbox_id, execution_id)
kill(sandbox_id, execution_id)
destroy_sandbox(sandbox_id)
```

Execution plane to control plane:

```text
execution_started
stdout_chunk
stderr_chunk
execution_completed
sandbox_error
heartbeat
```

## 6. Security Implementation

### 6.1 Secrets

- Store long-lived integration credentials in a vault.
- Issue task-scoped short-lived tokens through Secret Broker.
- Never persist secret values in events, artifacts, memory, or prompts.
- Redact known secret patterns from logs before writing artifacts.

### 6.2 Sandbox Policy

- Default no inbound network to sandbox.
- Egress allowlist by tenant/workspace/task.
- Mount only scoped workspace paths.
- Prefer read-only mounts where mutation is unnecessary.
- Destroy short-task sandboxes after completion.
- Preserve only declared artifacts.

### 6.3 Approval Policy

Actions requiring approval by default:

- external messages to customers or partners
- production deployments
- production data mutation
- deletion or destructive operations
- payment, billing, contract, or legal actions
- memory writeback of sensitive or organization-wide knowledge
- granting new tool permissions

## 7. Observability

### 7.1 Metrics

Track:

- task completion rate
- approval wait time
- agent execution duration
- sandbox startup time
- tool call latency and denial rate
- review approval/rejection rate
- retry count by agent
- memory writeback acceptance rate
- cost per session

### 7.2 Logs and Traces

Use correlation IDs:

```text
tenant_id
user_id
task_id
session_id
assignment_id
sandbox_id
execution_id
tool_call_id
trace_id
```

### 7.3 Debuggability

Every session should answer:

- who requested the work
- which agent ran
- what command/tool executed
- what permissions were checked
- what approval was granted or denied
- what artifacts were produced
- what memory was read or written
- why the workflow completed, failed, or paused

## 8. Deployment Topology

### 8.1 Local MVP

```text
Relay web app
Relay local API
PostgreSQL (via `RELAY_DATABASE_URL`)
BoxLite sandbox
Claude/Codex/Pi CLIs in sandbox
```

### 8.2 Team Server MVP

```text
Web app
Control Plane API
PostgreSQL
Redis
Temporal
BoxLite worker hosts
MCP Gateway
Secret Broker
Object storage
```

### 8.3 Enterprise SaaS / Private Deployment

```text
Next.js web app
Control Plane API service
Workflow service
Execution manager
Sandbox worker pool
MCP Gateway
Policy service
Secret Broker
Memory service
PostgreSQL
Redis
Temporal cluster
Vector/search storage
Object storage
Audit/SIEM export
```

## 9. Current Local Implementation

This blueprint does not duplicate the fast-changing repository map or local
operator workflow. Use these living owners instead:

- [AGENTS.md](../AGENTS.md) for current module ownership, runtime
  invariants, and verification expectations.
- [Local Development](local-development.md) for setup, environment, service
  commands, data layout, and tests.
- [HTTP API and Web URL Contract](api.md) for current browser and API paths.
- [Relay Daemon Node](../packages/relay-daemon/README.md) for the execution-plane
  environment, workspace, and delivery contract.

Update those owners when the implementation changes; keep this document focused
on the target system and its delivery phases.

## 10. Key Engineering Decisions

| Decision | Direction |
| :- | :- |
| Control plane location | outside sandbox |
| Sandbox process | optional minimal guest worker only |
| Durable state | PostgreSQL/event-sourced task and session logs |
| Workflow engine | Temporal for long-running/resumable work |
| Agent CLIs | executed inside sandbox |
| Secrets | short-lived task-scoped credentials |
| Tool access | MCP Gateway with policy and audit |
| Memory | layered memory with reviewed writeback |
| API state | task/session APIs are canonical, channels are clients |
| Current local mode | PostgreSQL is required for sessions and tasks; local files are limited to remaining operational compatibility state |

## 11. Open Technical Questions

- Should the guest worker use stdio, Unix socket, or localhost HTTP inside the sandbox?
- What is the minimum policy language for tool and approval rules?
- How much LangGraph is needed once Temporal owns durable state?
- Which memory candidates require human review by default?
- What sandbox tier should be the default for enterprise private deployment?
- How should artifact redaction be implemented before persistence?

## 12. Immediate Next Steps

1. Keep ADRs current for control-plane placement, sandbox guest-worker scope, and governed tool authority.
2. Continue expanding the TypeScript `ExecutionManager` boundary toward `SandboxHandle` and `ExecutionHandle` contracts.
3. Move remaining direct BoxLite usage behind the execution interface without changing behavior.
4. Keep current `SessionController` as the local durable orchestration boundary.
5. Add tests proving agent execution still streams, captures artifacts, supports cancellation, and never moves task authority into the sandbox.
