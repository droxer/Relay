# ADR-026: Workflows belong to their creating Team or Project

## Status

Accepted. Revises ADR-025's Project-only definition ownership. Its frozen-run,
owner authorization and daemon execution policies remain unchanged.

## Decision

Each custom definition has exactly one owner scope: `ownerTeamId` or `projectId`.
Creating in a Team needs no Project and assigns ownership to that Team. Its
Tasks and Automations may reuse the definition across compatible Projects.
Creating in a Project assigns ownership to that Project. Any Task or Automation
in that Project may select it, regardless of Team links. Owner scope is immutable.
Team links to a Project definition remain references and never confer ownership.

Execution still requires a Project, chosen when starting or inherited from the
Task/Automation. A Team-owned Workflow requires its owning Team assignment.
Steps retain explicit Agents, which must be enabled in the execution Project,
placed on its Computer and, when a Team is selected, members of that Team.
A run freezes the chosen Project without binding or rewriting the reusable
Team definition. Missing/incompatible participants fail closed.

Migration 0130 adds an optional Team owner, makes Project scope nullable, and
enforces exactly one scope in the database. Existing definitions remain Project
owned: their links are not sufficient evidence to transfer ownership. Downgrade
refuses while Team-owned definitions exist. Team deletion makes its definitions
unavailable for new runs; history remains readable.
