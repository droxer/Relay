# Relay Architecture Decision Records

This directory records durable architecture decisions for Relay.

The ADR numbering follows the decisions referenced in
[`docs/system-architecture.md`](../system-architecture.md) and should be kept in
sync with [`docs/implementation-plan.md`](../implementation-plan.md).

| ADR | Decision |
| :- | :- |
| [ADR-007](007-governed-enterprise-authority.md) | Governed enterprise authority instead of opaque agent autonomy |
| [ADR-008](008-boxlite-lightweight-execution.md) | BoxLite-first lightweight execution boundary |
| [ADR-009](009-control-plane-outside-sandbox.md) | Durable control plane remains outside sandbox |
| [ADR-010](010-leased-agent-node-delivery.md) | Explicit leased, at-least-once agent-node delivery |
| [ADR-011](011-node-scoped-agent-collaboration.md) | Node-scoped agent collaboration and immutable thread runtime |
| [ADR-012](012-canonical-web-and-api-urls.md) | Clean browser paths and versioned API namespaces |
| [ADR-013](013-thread-scoped-workspaces.md) | Thread-scoped workspaces for local and cloud computers |
| [ADR-014](014-agent-team-round-contracts.md) | Explicit, auditable agent-team round contracts |
| [ADR-015](015-adaptive-agent-execution.md) | Adaptive agent execution by default |
| [ADR-016](016-collaboration-conductor.md) | Event-sourced collaboration conductor as workflow authority |
| [ADR-017](017-computer-bound-project-workspaces.md) | Computer-bound project workspaces |
| [ADR-018](018-durable-task-workspace-bindings.md) | Durable task workspace bindings, visible waits, and retained artifact versions |
