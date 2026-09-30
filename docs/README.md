# Relay documentation

[English](README.md) | [简体中文](README.zh-CN.md)

This index identifies the owner for each documentation topic. Overview files
summarize and link; they should not copy operational detail from the owning
document.

## Start here

- [`../README.md`](../README.md) — product overview and shortest path to a
  running development environment.
- [`local-development.md`](local-development.md) — canonical environment,
  setup, service, data-layout, and test workflow.
- [`deployment.md`](deployment.md) — canonical hosted deployment procedure
  (web UI on Vercel, backend and Postgres on Railway) and the origin, cookie,
  and proxy settings it requires.
- [`../backend/migrations/README.md`](../backend/migrations/README.md) —
  canonical database migration and legacy-session import procedure.
- [`api.md`](api.md) — current browser-route and HTTP API contract.
- [`../AGENTS.md`](../AGENTS.md) — Codex repository map, engineering
  invariants, and verification guidance.
- [`../CLAUDE.md`](../CLAUDE.md) — Claude Code commands, architecture details,
  invariants, and test guidance.
- [`../CONTEXT.md`](../CONTEXT.md) — short canonical product terminology.
- [`CODEX-NAVIGATION-GUIDE.md`](CODEX-NAVIGATION-GUIDE.md) — where behavior
  lives, which neighboring surfaces move with it, and what a review diff
  packet must show.

## Product and architecture

- [`product.md`](product.md) owns product direction, users, scenarios, and
  roadmap.
- [`agent-facing-product-design.md`](agent-facing-product-design.md) owns the
  employee-facing agent model and vocabulary boundary.
- [`system-architecture.md`](system-architecture.md) owns target architecture
  and strategic technology choices.
- [`implementation-plan.md`](implementation-plan.md) translates that target
  into service boundaries, data models, APIs, runtime flows, and phases.
- [`agent-first-runtime-design.md`](agent-first-runtime-design.md) owns the
  logical-agent runtime design.
- [`managed-node-provisioning.md`](managed-node-provisioning.md) owns managed
  computer desired state, enrollment, reconciliation, and provider lifecycle.
- [`node-heartbeats.md`](node-heartbeats.md) owns the execution-plane liveness
  lease.
- [`chat-integrations.md`](chat-integrations.md) owns provider setup, identity
  mapping, commands, security, and operations for chat channels, a feature
  that is disabled by default (`RELAY_CHANNELS_ENABLED`). The
  [`relay-chat` package README](../packages/relay-chat/README.md) stays limited
  to package boundaries.
- The [`relay-daemon` README](../packages/relay-daemon/README.md) owns the
  daemon environment and delivery contract.

## Decisions and design

- [`adr/README.md`](adr/README.md) indexes accepted architecture decisions.
  ADRs preserve why a decision was made; living guides above describe the
  current contract.
- [`design-system.md`](design-system.md) is the sole living visual-system and
  token reference.
- [`../assets/brand/README.md`](../assets/brand/README.md) describes asset files
  and usage without repeating design tokens.

## Ownership rules

1. Put current commands and configuration in the nearest operational owner,
   then link to it from overview documents.
2. Put durable rationale in an ADR; do not restate the complete current
   contract there.
3. Keep an active implementation or migration plan only while work remains.
   Give it a dated status, and remove it after the living contract and tests
   describe the shipped behavior.
4. Do not keep completed implementation diaries, dated audits, design
   explorations, or test evidence in the living docs tree. Git history and the
   executable test suite retain that record.
5. When replacing a design, update the living owner and remove the superseded
   document after preserving any durable rationale in an ADR.
6. Agent-specific instruction files may repeat critical commands and invariants
   so each agent receives complete context without following another agent's
   bootstrap file.
