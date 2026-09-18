import type { AgentTeam, CurrentUser, LogicalAgentAvailability } from "../types.js";
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
