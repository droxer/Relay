import type { AgentTeam, CurrentUser, EmployeeAgent, LogicalAgentAvailability, RelayTaskListItem } from "../types.js";
import { isLogicalAgentRoutable } from "./agentDisplayNames.ts";

/** Can this agent/team be offered for a task assigned to `assigneeEmployeeId`?
 *
 *  An owned record belongs to one employee and is offered only to them. An
 *  OWNERLESS record is globally assignable — agents and teams are not always
 *  employee-scoped, and hiding them left the picker with nothing to show.
 *  This mirrors the backend rule that ownerless sessions are allowed. */
export function assignmentOptionVisible(
  ownerEmployeeId: string | undefined,
  assigneeEmployeeId: string,
  selected: boolean,
): boolean {
  if (selected) return true;
  if (!assigneeEmployeeId) return true;
  if (!ownerEmployeeId) return true;
  return ownerEmployeeId === assigneeEmployeeId;
}

type ComputerPlaced = {
  id: string;
  placements: ReadonlyArray<{ computerId?: string; desiredState: string }>;
};

/** Computers the agent lives on — one, by invariant, but read defensively. */
function agentComputerIds(agent: Pick<ComputerPlaced, "placements">): Set<string> {
  // Read defensively: a partial record (a stale cache, a narrow fixture) may
  // carry no placements at all, which simply means "on no computer".
  return new Set(
    (agent.placements ?? [])
      .filter((placement) => placement.desiredState !== "removed" && placement.computerId)
      .map((placement) => placement.computerId as string),
  );
}

/** Mirrors `agent_on_project_computer` in `backend/relay/services/project_runtime.py`. */
export function agentOnComputer(
  agent: Pick<ComputerPlaced, "placements">,
  computerId: string,
): boolean {
  return agentComputerIds(agent).has(computerId);
}

/** Every member is on the computer. A member the roster does not know fails. */
export function teamOnComputer(
  team: { memberAgentIds: readonly string[] },
  agents: readonly ComputerPlaced[],
  computerId: string,
): boolean {
  const memberAgentIds = team.memberAgentIds ?? [];
  if (memberAgentIds.length === 0) return false;
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  return memberAgentIds.every((agentId) => {
    const agent = byId.get(agentId);
    return Boolean(agent && agentOnComputer(agent, computerId));
  });
}

/** A round runs on one computer, so a team is only dispatchable when its
 *  whole roster shares one — whichever that is. */
export function teamSharesOneComputer(
  team: { memberAgentIds: readonly string[] },
  agents: readonly ComputerPlaced[],
): boolean {
  const first = agents.find((agent) => agent.id === team.memberAgentIds?.[0]);
  if (!first) return false;
  return [...agentComputerIds(first)].some((computerId) => teamOnComputer(team, agents, computerId));
}

export function teamReady(team: Pick<AgentTeam, "enabled" | "members" | "memberConfigs" | "leadAgentId">): boolean {
  return teamAvailability(team) === "ready";
}

/** Only automatic participants constrain normal dispatch; addressed specialists
 * are checked independently when a user selects them. */
export function teamAvailability(
  team: Pick<AgentTeam, "enabled" | "members" | "memberConfigs" | "leadAgentId">,
): LogicalAgentAvailability {
  const members = team.members.filter(member => member.id === team.leadAgentId || team.memberConfigs?.[member.id]?.participation !== "on_request");
  if (!team.enabled || members.length === 0) return "offline";
  if (members.some((member) => !member.enabled || member.availability === "offline")) {
    return "offline";
  }
  if (members.some((member) => member.availability === "pending")) return "pending";
  if (members.some((member) => member.availability === "busy")) return "busy";
  return "ready";
}

/** A team must be active and fully backed by routable members, mirroring
 *  the single-agent rule: ready and busy can take work. */
export function isTeamRoutable(
  team: Pick<AgentTeam, "enabled" | "deletedAt" | "members" | "memberConfigs" | "leadAgentId">,
): boolean {
  return team.enabled && !team.deletedAt && isLogicalAgentRoutable(teamAvailability(team));
}

/** Human label for a task's assignee. `employeeNames` is the resolved employee
 *  directory (see useEmployeeNames); without it, everyone but the viewer falls
 *  back to the raw employee id, which is what the Assignee column used to show. */
export function taskAssigneeDisplayName(
  task: {
    assigneeEmployeeId?: string;
    ownerEmployeeId?: string;
    assignedTeamId?: string;
  },
  currentUser: CurrentUser,
  employeeNames?: ReadonlyMap<string, string>,
): string | undefined {
  const employeeId = task.assigneeEmployeeId ?? task.ownerEmployeeId;
  if (!employeeId) return undefined;
  if (employeeId === currentUser.employeeId || employeeId === currentUser.id) {
    return currentUser.displayName?.trim() || currentUser.username;
  }
  return employeeNames?.get(employeeId) ?? employeeId;
}

/** What `taskAssigneeDisplayName` returns when the directory cannot name an
    employee: the raw id. Display surfaces test this to substitute a real
    label ("Unknown employee") — a UUID where a name belongs is how cards used
    to announce an assignee called "0 064b131e-6f…". */
export const UNRESOLVED_EMPLOYEE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True when the task's owning employee is the viewer. Personal views
 *  (backlog/routine) suppress the redundant self chip and let the executor
 *  glyph stand in as the assignee. */
export function isTaskAssigneeCurrentUser(
  task: { assigneeEmployeeId?: string; ownerEmployeeId?: string },
  currentUser: CurrentUser,
): boolean {
  const employeeId = task.assigneeEmployeeId ?? task.ownerEmployeeId;
  if (!employeeId) return false;
  return employeeId === currentUser.employeeId || employeeId === currentUser.id;
}

/** Resolve execution identity independently of the employee responsible for the task. */
export function taskAgentDisplayName(
  task: RelayTaskListItem,
  agents: readonly Pick<EmployeeAgent, "id" | "displayName">[],
  teams: readonly Pick<AgentTeam, "id" | "name">[],
): string | undefined {
  if (task.assignedTeamId) return teams.find((team) => team.id === task.assignedTeamId)?.name;
  return agents.find((agent) => agent.id === task.assignedAgentId)?.displayName;
}

export function taskAssigneeLabel(
  task: RelayTaskListItem,
  resolvedName: string | undefined,
  t: (key: string) => string,
): string {
  if (task.assignedTeamId) return resolvedName || t("backlog.assignment_unavailable_team");
  if (task.assignedAgentId) return resolvedName || t("backlog.assignment_unavailable_agent");
  return task.assignedAgent || t("backlog.unassigned");
}
