# Unfinished designs

These documents contain proposed behavior or a mixture of implemented foundations
and unfinished rollout work. Their status sections describe that boundary;
use the [API reference](../api.md), [current guides](../README.md#guides), and code
for implemented contracts.

| Design | Remaining scope |
| --- | --- |
| [Daemon reliability and runtime scaling](daemon-runtime-scaling.md) | Remaining lifecycle extraction, persistence offloading, production telemetry, and scale-validation gates |
| [Agent runtime](agent-first-runtime-design.md) | Placement reconciliation, artifact transfer, and compatibility retirement |
| [Managed computer provisioning](managed-node-provisioning.md) | Remaining provisioning workflow and provider design; the local-process and Fly Machines providers already exist |
| [Connections](connections-design.md) | Providers beyond GitHub, native event subscriptions, and management extensions |
| [Project-owned tasks](project-task-ownership-design.md) | Backend-wide required ownership, legacy migration, and deferred computer setup |

Update or remove a proposal when its work ships. Keep lasting rationale in an
[ADR](../adr/README.md); implementation checklists and test transcripts belong
in Git history.
