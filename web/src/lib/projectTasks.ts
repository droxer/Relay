import {
  compareTaskQueue,
  TASK_FLOW_STAGES,
  taskWorkflowStage,
  type TaskWorkflowStage,
} from "./taskFlow.ts";
import type { AgentTeam, EmployeeAgent, RelayTaskListItem, TaskStatus } from "../types.js";

/**
 * What a project's task board is made of.
 *
 * The board used to derive all of this inline, and drifted from the backlog
 * it mirrors: it printed a raw `agent:<id>` for an agent that had left the
 * roster, called a team-assigned task unassigned, and labelled a card with a
 * status its own lane contradicted. Deriving it here — once, in terms the
 * backlog already uses (`taskWorkflowStage`, `compareTaskQueue`) — is what
 * keeps the two surfaces saying the same thing about the same task.
 */

/** One project's live, non-routine tasks, in the queue order the backlog uses. */
export function projectTaskQueue(
  tasks: readonly RelayTaskListItem[],
  projectId: string,
): RelayTaskListItem[] {
  return tasks
    .filter((task) => task.projectId === projectId && !task.isRoutine && !task.deletedAt)
    .sort(compareTaskQueue);
}

export type ProjectTaskLane = {
  stage: TaskWorkflowStage;
  tasks: RelayTaskListItem[];
};

/** Every stage, in board order — an empty lane is a column, not an absence. */
export function projectTaskLanes(work: readonly RelayTaskListItem[]): ProjectTaskLane[] {
  return TASK_FLOW_STAGES.map((stage) => ({
    stage,
    tasks: work.filter((task) => taskWorkflowStage(task) === stage),
  }));
}

/**
 * The status a card has to spell out for itself.
 *
 * A lane is a workflow stage, and `taskWorkflowStage` folds `blocked` and
 * `waiting_for_human` into `running` — so a card that restated its raw status
 * in every lane read as a contradiction ("Blocked" under a "Running" header).
 * Only a status its lane cannot show is worth printing.
 */
export function laneExceptionStatus(task: RelayTaskListItem): TaskStatus | null {
  return task.status === taskWorkflowStage(task) ? null : task.status;
}

export type ProjectTaskProgress = {
  done: number;
  total: number;
  /** Tasks stopped on a human — blocked, or waiting for an answer. */
  attention: number;
  /** Completion as a whole percent; 0 for an empty project rather than NaN. */
  percent: number;
};

export function projectTaskProgress(work: readonly RelayTaskListItem[]): ProjectTaskProgress {
  const done = work.filter((task) => task.status === "done").length;
  const attention = work.filter(
    (task) => task.status === "blocked" || task.status === "waiting_for_human",
  ).length;
  const total = work.length;
  return { done, total, attention, percent: total ? Math.round((done / total) * 100) : 0 };
}

/**
 * Who a task is on.
 *
 * A descriptor rather than a string, so the words stay in the translation
 * catalogue and the raw id stays out of the UI: a saved task can name an
 * agent or team that has since been deleted, and `*-missing` is what the
 * card renders then — the same rule `TaskDrawer` follows for its trigger.
 */
export type ProjectTaskAssignee =
  | { kind: "agent"; name: string }
  | { kind: "team"; name: string }
  | { kind: "agent-missing" }
  | { kind: "team-missing" }
  | { kind: "unassigned" };

export function projectTaskAssignee(
  task: RelayTaskListItem,
  agents: readonly EmployeeAgent[],
  teams: readonly AgentTeam[],
): ProjectTaskAssignee {
  // A team dispatches through its lead, so a task carrying both is the team's.
  if (task.assignedTeamId) {
    const team = teams.find((candidate) => candidate.id === task.assignedTeamId);
    return team ? { kind: "team", name: team.name } : { kind: "team-missing" };
  }
  if (task.assignedAgentId) {
    const agent = agents.find((candidate) => candidate.id === task.assignedAgentId);
    return agent ? { kind: "agent", name: agent.displayName } : { kind: "agent-missing" };
  }
  return { kind: "unassigned" };
}
