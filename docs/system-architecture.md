# Relay Architecture Design V2.0

<p align="center">
  <img src="../assets/brand/relay-logo.svg" alt="Relay logo" width="360">
</p>

Enterprise AI Workforce Platform / Agent Runtime / Sandbox / Memory / Governance

This document defines Relay's target architecture, strategic technology choices, and architectural decision direction. It explains what the system should become and why.

For current implementation boundaries and source ownership, see the
[code navigation guide](CODEX-NAVIGATION-GUIDE.md). The [API reference](api.md)
describes implemented HTTP contracts; [unfinished designs](proposals/README.md)
track remaining proposals.

This is a target architecture, not a list of deployed services. Section 4
separately describes the implemented MCP boundary; its source map is in the
[Codex Navigation Guide](CODEX-NAVIGATION-GUIDE.md).

## 0. Executive Summary

Relay should not be designed as "a chatbot plus several tool calls." It should be designed as infrastructure for an enterprise hybrid workforce platform. It needs durable identity, resumable tasks, auditable execution, sandbox isolation, enterprise permissions, organizational memory, and multi-agent collaboration.

Based on comparison with and reflection on the technology choices of general-purpose autonomous agents such as Manus, Relay's architecture philosophy is clearer: we are not giving an LLM an all-powerful "mechanical hand" that pursues maximum low-level VM freedom. We are giving the LLM an "enterprise badge" that prioritizes compliance, permission checks, long-running process control, and human-in-the-loop governance.

The recommended architecture uses four architectural planes: Control Plane, Execution Plane, Memory Plane, and Governance Plane. These planes are implemented through six runtime layers: Channel, Control Plane, Agent Runtime, Execution Plane, Tool Layer, and Knowledge/Memory Layer.

| Decision Area | Recommendation |
| :-: | :-: |
| Overall Architecture | Control Plane + Execution Plane + Memory Plane + Governance Plane |
| MVP Stack | Web/API control plane + PostgreSQL + Redis + Temporal + Relay Runtime + BoxLite / Kubernetes Sandbox + MCP Gateway |
| Sandbox Strategy | Cloud Workstations for long-running development; BoxLite for frequent lightweight short tasks and serverless agents; Kubernetes Jobs as the baseline for regular tasks; gVisor or managed cloud sandboxes such as E2B for high-risk tasks. |
| Data Strategy | PostgreSQL as the source of truth; start with pgvector; split to Qdrant, OpenSearch, or ClickHouse as scale requires. |
| Permission Strategy | Four-layer validation: User Permission + Agent Permission + Task Permission + Tool Policy. |
| Core Moat | Organizational memory, long-running task state machines through Temporal, tool-call audit, Memory Writeback, and enterprise governance. |

## 1. Architecture Design Principles

- **Center user amplification, not agent theatrics**: every technical capability must serve the goal of helping users create value faster.
- **Separate the control plane and execution plane completely**: business management logic and untrusted task execution must be separated. The control plane remains stable, auditable, and low risk; the execution plane can be created, destroyed, and isolated elastically.
- **Check permissions before execution**: every tool call, file access, and system operation must pass identity, permission, task-scope, and policy checks before execution. An agent must not gain unlimited execution capability simply because it inherits a user identity.
- **Prefer process governance over emergent autonomy**: unlike Manus-style approaches where a model observes screens and DOM directly, Relay should rely heavily on the MCP Gateway and structured API calls. Agents should not operate through opaque black boxes.
- **Make tasks resumable, not single-turn conversations**: introduce Temporal workflows for long-running tasks.
- **Layer memory and write it back**: personal memory, task memory, and project memory must be stored in layers and written back after task completion to build an enterprise experience graph.

## 2. Core System Architecture

Relay should be read in two views:

- **Architectural planes** define trust boundaries and ownership.
- **Runtime layers** define deployable responsibilities.

### 2.0 Public HTTP boundary

The implemented control plane exposes JSON resources beneath `/api/v1`, with
administration beneath `/api/v1/admin` and chat-service calls beneath
`/api/v1/internal/chat`. The web channel uses clean History API paths and calls
the same versioned resources as the daemon, supervisor, and chat gateway.
Internal `Session` models remain unchanged while the public browser and API term
is **thread**. See [HTTP API and Web URL Contract](api.md) and
[ADR-012](adr/012-canonical-web-and-api-urls.md).

### 2.1 Architectural Planes

| Plane | Owns | Must Not Own |
| :-: | :- | :- |
| Control Plane | tenants, users, tasks, sessions, approvals, workflow state, policy decisions | untrusted code execution |
| Execution Plane | sandboxed commands, agent CLIs, file processing, isolated tool adapters | durable authority, approvals, long-lived secrets, organization memory |
| Memory Plane | retrieval, memory objects, writeback, indexing, source links | raw unreviewed authority over enterprise truth |
| Governance Plane | identity, permissions, audit, policy, retention, approval rules | opaque agent behavior outside policy |

### 2.2 Runtime Layers

| Layer | Responsibility | Recommended Technology | Design Notes |
| :-: | :-: | :-: | :-: |
| Channel Layer | IM, web, email, and API entry points | Next.js, Bot Framework, Feishu / Slack / Teams SDKs | A task should be traceable across channels; IM should support approval cards. |
| Control Plane | Tenants, users, Agent ID, permissions, tasks, approvals | API service, PostgreSQL, Redis | PostgreSQL is the source of truth; high-risk actions must enter the Approval Service. |
| Agent Runtime | Task planning, state machine, tool policy, context assembly | LangGraph + custom Runtime + Temporal | Temporal handles reliable long-running processes; Relay Runtime handles business state and governance. |
| Execution Plane (Sandbox) | Isolated execution for untrusted code, file handling, CLI runs | BoxLite, Kubernetes, Cloud Workstations, gVisor | Choose isolation level by task risk and lifecycle; support fast cold starts and lightweight isolation. |
| Tool Layer | Internal system connections and tool exposure | MCP Gateway, CLI Adapter, Secret Broker | Tools must be registered, versioned, authorized, audited, and rate limited. |
| Knowledge and Memory Layer | Organizational knowledge, RAG, team experience capture | PostgreSQL, pgvector, Qdrant, OpenSearch | This layer must go beyond RAG and include Memory Writeback. |

## 3. Execution Plane and Sandbox Strategy

In V2, Relay incorporates lessons from general-purpose agents such as Manus, which uses AWS Firecracker and E2B-style sandboxing, while accounting for enterprise private deployment and infrastructure reuse. BoxLite is now a core candidate, and the sandbox tiering strategy has been refined.

### 3.1 Sandbox Technology Comparison: Relay vs. General-Purpose Agents

| Dimension | Manus Sandbox Choice (Firecracker Path) | Relay Optimized Sandbox Choice (BoxLite + Progressive Kubernetes Path) |
| :-: | :-: | :-: |
| Core Underlying Technology | AWS Firecracker MicroVMs, with cluster scheduling provided by E2B | Tiered isolation: BoxLite for frequent short tasks -> gVisor / Kubernetes Jobs -> Cloud Workstations |
| Isolation Level | Full VM-level isolation with an independent Linux kernel and strong escape resistance | Lightweight Rust-based container isolation and user-space kernel approach, balancing security and IT friendliness |
| Startup Speed | Extremely fast, around 125-150 ms, dependent on warmed memory snapshots | BoxLite can significantly reduce short-task startup latency and replace second-level Kubernetes scheduling for that class of work |
| Environment Richness | A "real computer" with browser, complete OS, and preinstalled tools | An on-demand assembled environment, more lightweight and bounded through the CLI Adapter |
| Operations and Deployment Cost | Self-built scheduling networks are extremely complex and operationally demanding | BoxLite is compatible with OCI images, reuses existing Kubernetes and CI/CD, and is suitable for private deployment |

### 3.2 Updated Sandbox Tiering Recommendation

| Risk Level | Task Type | Execution Environment | Design Rationale |
| :-: | :-: | :-: | :-: |
| L0 Low Risk | Pure text summarization, RAG queries, no code execution | No sandbox or restricted worker | No outbound network or controlled egress. |
| L1 Frequent Lightweight Tasks | Short code snippets, data conversion, quick API wrapping | BoxLite | Replace Kubernetes Jobs for frequent lightweight tasks; use low-latency startup and strong isolation for disposable execution. |
| L2 Medium Risk / Long-running | Batch file processing, complex scripts, dependency installation | Kubernetes Job + gVisor | Use gVisor to add defense in depth for multi-tenant SaaS. |
| L3 High Risk | Unknown code execution, customer-uploaded code | Managed cloud sandbox such as E2B / Kata | For SaaS, buy E2B where appropriate; for private deployment, accept the heavier cost of Kata when needed. |
| L4 Long-lived Workspace | Continuous development with Claude Code and similar tools | Cloud Workstations | Provide persistent, enterprise-controlled development environments. |

## 4. Tool Layer: MCP Gateway and CLI Adapter

### 4.1 Implemented MCP boundaries

Relay currently exposes two distinct MCP tool surfaces. Both keep application
authority in the Python control plane while Agent Runtimes execute on Computers.

| Surface | Purpose | Backend boundary | Runtime access |
| --- | --- | --- | --- |
| Relay MCP | Read Project records and stage Task proposals for owner review | `backend/relay/mcp/`, `POST /api/v1/mcp` | Codex, Claude Code, OpenCode, Kimi and Pi through the local bridge or daemon run proxy |
| Service Connections | Call external services within explicitly selected work Grants; currently GitHub issue reads | `backend/relay/api/connections/tools.py`, `POST /api/v1/connection-tools` | Per-run stdio proxy for Codex and Claude; requires `service-connections` |

These endpoints have separate catalogs, credentials and authorization rules.
A Relay MCP token does not grant access to a Connection or its provider secrets.
The general enterprise MCP Gateway remains a target, rather than an additional
deployed service implied by these interfaces.

### 4.2 Relay MCP ownership and request flow

The official MCP Python SDK serves stateless JSON Streamable HTTP inside the
existing FastAPI deployment. `app.py` starts and stops it with the backend
lifespan. Python owns the protocol, tool schemas, bearer authorization and
Project operation dispatch; the backend calls application operations directly
without HTTP calls back into itself. Computers need no Python installation or
additional MCP service or port.

```text
Standalone local Agent Runtime
  -> Node stdio bridge (relay-mcp.ts / relay-mcp-http.ts)
  -> POST /api/v1/mcp with Computer- or owner-scoped MCP token

Relay-managed Agent Runtime (native or isolated)
  -> run transport -> daemon proxy (relay-mcp-managed.ts)
  -> exchange command/lease for MCP token held in daemon memory
  -> POST /api/v1/mcp with command-bound MCP token

Python MCP protocol -> Project authorization -> Project application operations
  -> scoped reads or pending proposal -> owner reviews and applies in the web UI
```

The Node bridge handles newline stdio framing and HTTP forwarding, including
negotiated protocol metadata; it owns no second tool catalog. The older
`GET /api/v1/mcp/projects` and `POST /api/v1/mcp/projects/{id}/tools` routes are
compatibility adapters over the same Python authorization and operations.

The catalog has eight read tools and one proposal tool. A Project roster member's
run sees the read tools; only its Project Manager's run receives proposal access.
Owner and standalone Computer grants can also stage proposals within their
scope. `relay_propose_task_changes` never applies changes, starts work, accepts
outcomes or reconciles execution. Apply requires the owner's browser session
and normal domain validation. See the [tool catalog and capability rules](guides/project-manager.md#mcp-tools).

### 4.3 Credentials and transport guarantees

| Credential | Scope and lifetime | Storage and lifecycle |
| --- | --- | --- |
| Owner-issued MCP token | Explicit list of owned Projects; 90 days | Returned once; owner stores it privately and can revoke it |
| Standalone Computer MCP token | Owner's Projects on that Computer; 90 days | Private daemon credential file; renewal within seven days of expiry or after expiry; revoked/unknown tokens require explicit reconnection |
| Managed run MCP token | Admitted Project and assignment's reader/manager access; at most 24 hours | Daemon memory only; authentication also requires the command to remain dispatched and its run request active |

The database stores only token digests (`persistence/account/mcp_tokens.py`,
`persistence/tables/mcp.py`; migration `20261106_0115`). The daemon credential
authorizes token issuance, not Project tool calls. Managed processes receive
`RELAY_MCP_RUN_CONTEXT` transport metadata, never the run token; runs without
Project roster access receive a disabled context and cannot fall back to the
standalone grant. Admitted rounds retain their pinned roster context on manager
handover; subsequent rounds resolve the new holder.

Every hosted MCP request authenticates independently, including initialization
and notifications. Browser cookies alone confer no MCP authority. Grants remain
request-local, Origin policy is enforced, and responses use `no-store`.
Authenticated GET/DELETE return 405: this endpoint has no server event stream or
resumable session. Requests are bounded to 128 KiB and serialized tool results to
1 MiB. The local bridge refuses redirects and requires HTTPS except for loopback
HTTP. Errors hide credentials and internal exception details.

Native processes still share the owner's OS account; run-scoped tool requests do
not provide host filesystem isolation. Use a sandbox for that boundary.
See the [API contract](api.md#relay-mcp-bearer-token-api),
[runtime installation and token lifecycle](guides/project-manager.md#local-agent-runtimes),
and [Service Connections](guides/connections.md) for their separate Grant model.

### 4.4 Target enterprise gateway

Relay's broader Tool Layer should support both MCP and CLI access to enterprise
systems, extending the implemented boundaries above with centrally governed
tool registration and policy:

- **Tool Registry**: every tool must be discoverable, authorizable, and auditable.
- **MCP Gateway**: proxy internal systems through centralized authentication, rate limiting, and tenant isolation.
- **Secret Broker**: issue short-lived tokens per task; never inject long-lived secrets into agent context.

## 5. Updated MVP Delivery Plan: Phase 1

For the MVP, Relay should hold strict boundaries and focus on closed-loop value instead of prematurely building complex low-level VM infrastructure.

- **Core orchestration**: Temporal manages long-running workflow state machines, while LangGraph handles model-side logic.
- **Sandbox delivery**: prioritize BoxLite with existing Kubernetes infrastructure for low-cost, fast-start lightweight task validation, and prove OCI image invocation end to end.
- **Enterprise integration**: focus on the MCP Gateway and validate safe internal-system calls through controlled APIs, without relying on agents scraping screens or viewports.
- **Signature capabilities**: human-in-the-loop approval and Memory Writeback must work in the MVP to demonstrate the enterprise value of process governance and organizational memory.

## 6. Conclusion and Architecture Decision Updates

- **[New ADR-008](adr/008-boxlite-lightweight-execution.md)**: For lightweight and low-to-medium-risk agent task execution, prioritize evaluating BoxLite as a replacement for native Kubernetes Pods to achieve faster startup and a better serverless-agent experience while remaining compatible with existing enterprise OCI infrastructure.
- **[Strengthened ADR-007](adr/007-governed-enterprise-authority.md)**: Maintain the design philosophy of "issuing an enterprise badge, not building a mechanical hand." All tasks involving writes to external systems or sensitive internal reads must enforce multi-layer permission checks and route through the Approval Service.
- **[New ADR-009](adr/009-control-plane-outside-sandbox.md)**: Keep the durable Relay daemon and control-plane authority outside the sandbox. A sandbox may run only a minimal guest worker for approved command execution, stream forwarding, exit-status reporting, and local file operations.
- **[New ADR-010](adr/010-leased-agent-node-delivery.md)**: Use explicit, bounded command leases and at-least-once delivery between the control plane and daemon nodes. Only daemon-reported active commands renew ownership; cancellation remains retryable until the run is terminal.
- **[ADR-012](adr/012-canonical-web-and-api-urls.md)**: Use clean browser paths and a canonical `/api/v1` JSON boundary without pre-release compatibility aliases.
- **[ADR-013](adr/013-thread-scoped-workspaces.md)**: Give each thread an isolated directory beneath the user-selected local or supervisor-provisioned cloud workspace root.
- **[ADR-020](adr/020-work-outcomes.md)**: Keep execution completion separate from work outcomes, apply work-report gates to single-agent action runs on capable daemons, and distinguish reported completion from explicit human acceptance.
