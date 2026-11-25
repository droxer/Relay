# Relay documentation

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md)

## Use Relay

| Topic | Guide |
| --- | --- |
| Get started | [Accounts and onboarding](guides/accounts.md), [install the app](guides/pwa.md) |
| Organize and run work | [Tasks](guides/task-lifecycle.md), [Automations](guides/automations.md), [Teams and Workflows](guides/team-workflows.md) |
| Configure Agents | [Agent model](guides/agents.md), [published Skills](guides/skills.md), [Project Lead and Relay MCP](guides/project-manager.md) |
| Connect services | [Connections](guides/connections.md), [GitHub issue import](guides/github-connection.md) |

## Deploy and operate

| Topic | Guide |
| --- | --- |
| Hosted deployment | [Cloudflare and Railway architecture](guides/deployment-cloudflare.md#deployment-architecture), [deployment scripts](../deploy/README.md), [Vercel alternative](guides/deployment.md) |
| Backend and database | [Operations and upgrades](guides/backend-operations.md), [database migrations](../backend/migrations/README.md), [background jobs](guides/background-jobs.md) |
| Computers | [Daemon reference](../packages/relay-daemon/README.md), [heartbeat leases and report recovery](guides/node-heartbeats.md) |
| Chat providers | [Chat integrations](guides/chat-integrations.md) |

## Develop and contribute

- [Local development](local-development.md) covers setup, troubleshooting, and tests.
- [API reference](api.md) covers browser routes and HTTP contracts.
- [Code navigation](CODEX-NAVIGATION-GUIDE.md) maps the implementation and test entry points.
- [Domain glossary](../CONTEXT.md) and [agent instructions](../AGENTS.md) describe shared terminology and repository rules.
- [Design system](design-system.md), [typography](guides/typography.md), [product labels](guides/product-copy.md), and [brand assets](../assets/brand/README.md) cover the UI.

## Product direction and decisions

- [Product direction](product.md) and [target architecture](system-architecture.md) describe the roadmap.
- [Architecture decisions](adr/README.md) preserve durable rationale and each decision's status.
- [Active proposals](proposals/README.md) list the designs with work remaining.

## Keeping this small

Update the existing guide for a topic instead of adding a parallel design or
implementation diary. Keep an unfinished proposal only while work remains,
with an explicit status. Preserve durable rationale in an ADR. Remove completed
plans, dated reviews, test transcripts, and generated measurements once current
guides and executable tests cover the result; Git history retains those records.
When moving or deleting a document, update its incoming links and remove unused
images in the same change.
