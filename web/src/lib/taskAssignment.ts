import type { AgentTeam, UserAgent, LogicalAgentAvailability, ProjectRecord, RelayTaskListItem, TaskMutationInput } from "../types.js";
import { isLogicalAgentRoutable } from "./agentDisplayNames.ts";
import { issueNeedsProject } from "./issueQueues.ts";
import type { TaskAssignmentSelection } from "./taskBoardForm.ts";

/** Can this agent/team be offered for a task assigned to `assigneeUserId`?
 *
 *  An owned record belongs to one user and is offered only to them. An
 *  OWNERLESS record is globally assignable — agents and teams are not always
 *  user-scoped, and hiding them left the picker with nothing to show.
 *  This mirrors the backend rule that ownerless sessions are allowed. */
export function assignmentOptionVisible(
  ownerUserId: string | undefined,
  assigneeUserId: string,
  selected: boolean,
): boolean {
  if (selected) return true;
  if (!assigneeUserId) return true;
  if (!ownerUserId) return true;
  return ownerUserId === assigneeUserId;
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

/** Mirrors `agent_on_project_computer` in `backend/relay/projects/runtime.py`. */
export function agentOnComputer(
  agent: Pick<ComputerPlaced, "placements">,
  computerId: string,
): boolean {
  return agentComputerIds(agent).has(computerId);
}

/**
 * Who a project thread may address: its enabled crew, then every other agent
 * on the project's computer. A member the project disabled stays out. Mirrors
 * `project_thread_assignments` in `backend/relay/projects/runtime.py`.
 */
export function projectThreadRoster(
  project: Pick<ProjectRecord, "computerId" | "leadAgentId" | "members">,
  agents: readonly ComputerPlaced[],
): { leadAgentId: string | null; memberAgentIds: string[] } {
  const listed = new Set(project.members.map((member) => member.agentId));
  const crew = project.members.filter((member) => member.enabled).map((member) => member.agentId);
  const neighbours = agents
    .filter((agent) => !listed.has(agent.id) && agentOnComputer(agent, project.computerId))
    .map((agent) => agent.id);
  return { leadAgentId: project.leadAgentId ?? null, memberAgentIds: [...crew, ...neighbours] };
}

/**
 * Who a bare message in a project thread reaches: the enabled crew, or — in a
 * project without one — the agents already in the thread. Mirrors the room
 * fallback in `project_thread_assignments`.
 */
export function projectRoomAgentIds(
  project: Pick<ProjectRecord, "members">,
  session: { participantAgentIds?: readonly string[]; ownerAgentId?: string } | undefined,
): string[] {
  const crew = project.members.filter((member) => member.enabled).map((member) => member.agentId);
  if (crew.length) return crew;
  if (session?.participantAgentIds?.length) return [...session.participantAgentIds];
  return session?.ownerAgentId ? [session.ownerAgentId] : [];
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

/**
 * The agents and teams a task may be given — the one rule the task drawer and
 * an inline row picker share. A project owns a computer and everyone on it
 * shares the project workspace, so a project task offers every agent (and
 * every team whose whole roster) lives there, plus the project's enabled
 * members. Outside a project a team still runs on one computer, so only a
 * co-located roster is offered. The current pick always stays listed so a
 * trigger can name it.
 */
export function taskAssignmentOptions({
  project,
  agents,
  teams,
  assigneeUserId,
  assignedAgentId,
  assignedTeamId,
}: {
  project?: Pick<ProjectRecord, "computerId" | "members"> | null;
  agents: readonly UserAgent[];
  teams: readonly AgentTeam[];
  assigneeUserId: string;
  assignedAgentId?: string;
  assignedTeamId?: string;
}): { agents: UserAgent[]; teams: AgentTeam[] } {
  const agentOnTaskComputer = (agent: UserAgent) => !project
    || project.members.some((member) => member.agentId === agent.id && member.enabled)
    || agentOnComputer(agent, project.computerId);
  const teamOnTaskComputer = (team: AgentTeam) => project
    ? teamOnComputer(team, agents, project.computerId)
    : teamSharesOneComputer(team, agents);
  return {
    agents: agents.filter((agent) => (agent.id === assignedAgentId || agentOnTaskComputer(agent))
      && assignmentOptionVisible(agent.supervisorUserId, assigneeUserId, agent.id === assignedAgentId)),
    teams: teams.filter((team) => (team.id === assignedTeamId || teamOnTaskComputer(team))
      && assignmentOptionVisible(team.ownerUserId, assigneeUserId, team.id === assignedTeamId)),
  };
}

/** Assignment is decided before work starts. A started task keeps its crew,
 *  and an intake issue has nowhere to run, so neither offers a picker. */
export function taskAssignmentEditable(task: RelayTaskListItem): boolean {
  return (task.status === "backlog" || task.status === "assigned") && !issueNeedsProject(task);
}

export type TaskAssignmentChange = TaskAssignmentSelection;

/** The PATCH an assignment change sends — the same fields the task drawer
 *  submits. The server derives the assignee from the agent's supervisor. */
export function taskAssignmentPatch(task: RelayTaskListItem, change: TaskAssignmentChange): TaskMutationInput {
  if (change.kind === "team") {
    return {
      assignedAgentId: null,
      assignedTeamId: change.id,
      collaborationStyle: task.collaborationStyle === "solo" ? "build_review" : task.collaborationStyle ?? "",
    };
  }
  if (change.kind === "agent") {
    return { assignedAgentId: change.id, assignedTeamId: null, collaborationStyle: "" };
  }
  return {
    assignedAgentId: null,
    assignedTeamId: null,
    collaborationStyle: "",
    // A Ready task with nobody on it is not ready.
    ...(task.status === "assigned" ? { status: "backlog" as const } : {}),
  };
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

/** Resolve execution identity independently of the user responsible for the task. */
export function taskAgentDisplayName(
  task: RelayTaskListItem,
  agents: readonly Pick<UserAgent, "id" | "displayName">[],
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
