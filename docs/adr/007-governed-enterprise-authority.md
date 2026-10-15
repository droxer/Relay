# ADR-007: Governed Enterprise Authority

## Status

Accepted, strengthened by Architecture Design V2.0.

## Context

Relay's product direction is user amplification, not agent theatrics or
user replacement. Enterprise customers need permission boundaries,
traceability, human approval, and auditability before they can trust agents with
business workflow execution.

The tempting architecture is to give a model broad low-level access to a
computer-like environment and let it operate through screens, DOMs, shells, and
ambient credentials. That approach maximizes autonomy but makes enterprise
governance difficult to prove.

## Decision

Relay will issue agents an enterprise badge, not a mechanical hand.

All sensitive reads, writes, external actions, and tool calls must route through
structured Relay boundaries: identity, task scope, agent permission, tool
policy, approval rules, and audit events. Agents can recommend, draft, and
execute approved actions, but they do not inherit unlimited user authority.

## Consequences

- Tool access belongs behind a Tool Registry, Policy Engine, MCP Gateway, and
  Secret Broker.
- High-risk writes require human-in-the-loop approval unless tenant policy
  explicitly allows automation.
- Agent prompts must not contain long-lived secrets.
- Audit events must explain who requested work, which agent acted, what policy
  was checked, and what result was produced.
- This may slow some workflows, but it is the correct tradeoff for enterprise
  adoption and trust.
