# Relay documentation

[English](README.md) | [简体中文](README.zh-CN.md)

## Start here

- [Local development](local-development.md) — setup, services, troubleshooting, and tests.
- [API reference](api.md) — browser URLs, HTTP contracts, and feature behavior.
- [Code navigation](CODEX-NAVIGATION-GUIDE.md) — implementation ownership and verification.
- [Product direction](product.md) and [target architecture](system-architecture.md) — strategy; proposed capabilities are not a list of shipped features.
- [Design system](design-system.md) — UI tokens and component contracts.
- [Domain glossary](../CONTEXT.md) and [agent instructions](../AGENTS.md).

## Guides

| Topic | Guide |
| --- | --- |
| Hosted deployment | [Deployment scripts](../deploy/README.md), [Cloudflare + Railway](guides/deployment-cloudflare.md), [Vercel alternative](guides/deployment.md) |
| Database upgrades | [Migrations](../backend/migrations/README.md), [backend operations and rollout cautions](guides/backend-operations.md) |
| Background processing | [Background jobs](guides/background-jobs.md) |
| Accounts and first run | [Invitations, password reset, and onboarding](guides/accounts.md) |
| Agents and execution | [Agent model](guides/agents.md), [daemon reference](../packages/relay-daemon/README.md), [heartbeat leases](guides/node-heartbeats.md) |
| Tasks and automation | [Task lifecycle](guides/task-lifecycle.md), [automations](guides/automations.md), [Project Manager and MCP](guides/project-manager.md) |
| External services | [Connections](guides/connections.md), [public GitHub issue import](guides/github-connection.md), [chat integration backend](guides/chat-integrations.md) |
| Skills | [Published skills](guides/skills.md) |
| Interface | [Typography](guides/typography.md), [product copy](guides/product-copy.md), [installable app](guides/pwa.md), [brand assets](../assets/brand/README.md) |

## Decisions and proposals

- [Architecture decisions](adr/README.md) preserve durable rationale and each decision's status.
- [Proposals](proposals/README.md) collect unfinished designs. Read their status before treating them as implemented behavior.
- [Product screenshots](images/) support the English and Chinese project READMEs.

## Keeping this small

Update the existing guide for a topic instead of adding a parallel design or
implementation diary. Keep an unfinished proposal only while work remains,
with an explicit status. Preserve durable rationale in an ADR. Remove completed
plans, dated reviews, test transcripts, and generated measurements once current
guides and executable tests cover the result; Git history retains those records.
When moving or deleting a document, update its incoming links and remove unused
images in the same change.
