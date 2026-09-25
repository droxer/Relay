import type { AgentTeam, EmployeeAgent } from "../types.js";

/*
 * A team lives on one computer. Team dispatch runs every member in one shared
 * workspace, so setup picks the computer first and the roster is drawn from
 * the agents on it — the same rule a project's crew follows. The backend
 * (`backend/relay/services/team_computer.py`) refuses a roster that spans
 * computers; these helpers keep the form from offering one.
 */

type TeamMembership = { memberIds: string[]; leadId: string };

/** The computers an agent runs on: its active placements, or the computer it
 *  was created on while nothing has been placed yet. Mirrors the backend.
 *
 *  Active only, like every *setup* rule (a project crew's
 *  `validate_project_roster`, the thread picker's `teamsForThreadNode`): a
 *  draining agent is leaving, so a new roster must not be built on it. This is
 *  deliberately stricter than `agentOnComputer` in `taskAssignment.ts`, which
 *  admits work to a roster that already exists. */
export function agentComputerIds(agent: EmployeeAgent): string[] {
  const placed = agent.placements
    .filter((placement) => placement.desiredState === "active" && placement.computerId)
    .map((placement) => placement.computerId as string);
  if (placed.length > 0) return [...new Set(placed)];
  return agent.computerId ? [agent.computerId] : [];
}

function isOnComputer(agent: EmployeeAgent, computerId: string): boolean {
  return agentComputerIds(agent).includes(computerId);
}

/** The agents a team on this computer may take, in roster order. Current
 *  members stay listed even when the computer does not host them, so a
 *  legacy split roster can be seen and trimmed rather than silently hidden. */
export function agentsForTeamComputer(
  agents: readonly EmployeeAgent[],
  computerId: string,
  memberIds: readonly string[],
): EmployeeAgent[] {
  if (!computerId) return [];
  return agents.filter((agent) => !agent.deletedAt
    && (isOnComputer(agent, computerId) || memberIds.includes(agent.id)));
}

/** Members the computer does not host — each one blocks saving. */
export function membersOffComputer(
  agents: readonly EmployeeAgent[],
  computerId: string,
  memberIds: readonly string[],
): string[] {
  return memberIds.filter((id) => {
    const agent = agents.find((candidate) => candidate.id === id);
    return !agent || !isOnComputer(agent, computerId);
  });
}

/** Switching computers keeps only the members the new one hosts; a lead who
 *  is dropped hands the role to the next remaining member. */
export function pruneMembershipToComputer(
  membership: TeamMembership,
  agents: readonly EmployeeAgent[],
  computerId: string,
): TeamMembership {
  const off = new Set(membersOffComputer(agents, computerId, membership.memberIds));
  const memberIds = membership.memberIds.filter((id) => !off.has(id));
  const leadId = memberIds.includes(membership.leadId) ? membership.leadId : (memberIds[0] ?? "");
  return { memberIds, leadId };
}

/** The computer a team lives on: the one it recorded, else — for a team
 *  saved before teams carried one — the computer hosting its whole roster,
 *  else its lead's, so a legacy split team opens on a sensible machine. */
export function teamComputerId(
  team: Pick<AgentTeam, "memberAgentIds"> & Partial<Pick<AgentTeam, "computerId" | "leadAgentId">>,
  agents: readonly EmployeeAgent[],
): string {
  if (team.computerId) return team.computerId;
  const rosters = team.memberAgentIds.map((id) => {
    const agent = agents.find((candidate) => candidate.id === id);
    return agent ? agentComputerIds(agent) : [];
  });
  const shared = (rosters[0] ?? []).filter((id) => rosters.every((roster) => roster.includes(id)));
  if (shared.length > 0) return [...shared].sort()[0];
  const lead = agents.find((agent) => agent.id === team.leadAgentId);
  return lead ? (agentComputerIds(lead)[0] ?? "") : "";
}
