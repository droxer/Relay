import type { AgentTeam, ProjectRecord, TeamMutationInput, TeamWorkflow, WorkflowMutationInput } from "../types.ts";

/**
 * The Project workflow Team editor's draft and its translation to the Team
 * write contract (`backend/relay/core/team_workflows.py`). The backend is the
 * authority; these checks only stop a save the server would refuse, so the
 * person sees which field to fix before the round trip.
 */

/** Limits mirrored from `team_workflows.py`. */
export const WORKFLOW_LIMITS = {
  steps: 64,
  name: 200,
  instructions: 8000,
  lines: 32,
  line: 2000,
} as const;

export type WorkflowStepDraft = {
  id: string;
  name: string;
  agentId: string;
  instructions: string;
  /** One acceptance criterion per line, as the person types it. */
  acceptanceCriteria: string;
  requiresApproval: boolean;
};

export type WorkflowTeamDraft = {
  name: string;
  steps: WorkflowStepDraft[];
};

export type WorkflowStepField = "name" | "agentId" | "instructions" | "acceptanceCriteria";
export type WorkflowFieldError = "required" | "too_long" | "too_many" | "not_member";
export type WorkflowDraftErrors = {
  name?: "required" | "too_long";
  steps?: "required" | "too_many";
  fields: Record<string, Partial<Record<WorkflowStepField, WorkflowFieldError>>>;
};

export function isWorkflowTeam(team: Pick<AgentTeam, "workflowSteps" | "projectId">): boolean {
  return Boolean(team.projectId || team.workflowSteps?.length);
}

/** A new stable step id; kept across edits and reorders. */
export function newWorkflowStepId(existing: readonly { id: string }[], random: () => string = randomToken): string {
  const taken = new Set(existing.map((step) => step.id));
  for (;;) {
    const id = `step-${random()}`;
    if (!taken.has(id)) return id;
  }
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyWorkflowStep(
  existing: readonly { id: string }[],
  agentId = "",
): WorkflowStepDraft {
  return {
    id: newWorkflowStepId(existing),
    name: "",
    agentId,
    instructions: "",
    acceptanceCriteria: "",
    requiresApproval: false,
  };
}

export function draftFromTeam(team: Pick<AgentTeam, "name" | "workflowSteps">): WorkflowTeamDraft {
  return {
    name: team.name,
    steps: (team.workflowSteps ?? []).map((step) => ({
      id: step.id,
      name: step.name,
      agentId: step.agentId,
      instructions: step.instructions,
      acceptanceCriteria: step.acceptanceCriteria.join("\n"),
      requiresApproval: step.requiresApproval,
    })),
  };
}

export function moveWorkflowStep(steps: readonly WorkflowStepDraft[], from: number, to: number): WorkflowStepDraft[] {
  if (from === to || from < 0 || to < 0 || from >= steps.length || to >= steps.length) return [...steps];
  const next = [...steps];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function replaceWorkflowStep(
  steps: readonly WorkflowStepDraft[],
  id: string,
  patch: Partial<WorkflowStepDraft>,
): WorkflowStepDraft[] {
  return steps.map((step) => step.id === id ? { ...step, ...patch } : step);
}

function lines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Agents a step may name: the Project's enabled members. */
export function enabledProjectAgentIds(project: Pick<ProjectRecord, "members">): string[] {
  return project.members.filter((member) => member.enabled).map((member) => member.agentId);
}

export function validateWorkflowDraft(draft: WorkflowTeamDraft, allowedAgentIds: readonly string[]): WorkflowDraftErrors {
  const errors: WorkflowDraftErrors = { fields: {} };
  const name = draft.name.trim();
  if (!name) errors.name = "required";
  else if (name.length > WORKFLOW_LIMITS.name) errors.name = "too_long";
  if (!draft.steps.length) errors.steps = "required";
  else if (draft.steps.length > WORKFLOW_LIMITS.steps) errors.steps = "too_many";
  const allowed = new Set(allowedAgentIds);
  for (const step of draft.steps) {
    const field: WorkflowDraftErrors["fields"][string] = {};
    const stepName = step.name.trim();
    if (!stepName) field.name = "required";
    else if (stepName.length > WORKFLOW_LIMITS.name) field.name = "too_long";
    if (!step.agentId) field.agentId = "required";
    else if (!allowed.has(step.agentId)) field.agentId = "not_member";
    const instructions = step.instructions.trim();
    if (!instructions) field.instructions = "required";
    else if (instructions.length > WORKFLOW_LIMITS.instructions) field.instructions = "too_long";
    const criteria = lines(step.acceptanceCriteria);
    if (!criteria.length) field.acceptanceCriteria = "required";
    else if (criteria.length > WORKFLOW_LIMITS.lines) field.acceptanceCriteria = "too_many";
    else if (criteria.some((entry) => entry.length > WORKFLOW_LIMITS.line)) field.acceptanceCriteria = "too_long";
    if (Object.keys(field).length) errors.fields[step.id] = field;
  }
  return errors;
}

export function workflowDraftValid(errors: WorkflowDraftErrors): boolean {
  return !errors.name && !errors.steps && Object.keys(errors.fields).length === 0;
}

/** The Team write body. A workflow Team never sends the legacy collaboration
 *  style or human approval: the backend refuses both
 *  (`team_workflow_legacy_policy_conflict`). Members are the steps' Agents;
 *  the Project lead leads when it owns a step, else the first step's Agent. */
export function workflowTeamInput(
  draft: WorkflowTeamDraft,
  project: Pick<ProjectRecord, "id" | "computerId" | "leadAgentId">,
  enabled = true,
): TeamMutationInput {
  const memberAgentIds = [...new Set(draft.steps.map((step) => step.agentId))];
  const leadAgentId = project.leadAgentId && memberAgentIds.includes(project.leadAgentId)
    ? project.leadAgentId
    : memberAgentIds[0] ?? "";
  return {
    name: draft.name.trim(),
    projectId: project.id,
    computerId: project.computerId,
    leadAgentId,
    memberAgentIds,
    enabled,
    workflowSteps: draft.steps.map((step) => ({
      id: step.id,
      name: step.name.trim(),
      agentId: step.agentId,
      instructions: step.instructions.trim(),
      acceptanceCriteria: lines(step.acceptanceCriteria),
      requiresApproval: step.requiresApproval,
    })),
  };
}

/** Whether the draft differs from what was saved (normalized, order kept). */
export function workflowDraftChanged(draft: WorkflowTeamDraft, saved: WorkflowTeamDraft): boolean {
  const normalize = (value: WorkflowTeamDraft) => JSON.stringify({
    name: value.name.trim(),
    steps: value.steps.map((step) => ({
      ...step,
      name: step.name.trim(),
      instructions: step.instructions.trim(),
      acceptanceCriteria: lines(step.acceptanceCriteria),
    })),
  });
  return normalize(draft) !== normalize(saved);
}

/** Workflow Teams that belong to this Project. */
export function projectWorkflowTeams(teams: readonly AgentTeam[], projectId: string): AgentTeam[] {
  return teams.filter((team) => !team.deletedAt && team.projectId === projectId && Boolean(team.workflowSteps?.length));
}


/** Definitions grouped under their owning Team, including legacy saved Teams. */
export function projectWorkflows(teams: readonly AgentTeam[], projectId: string): TeamWorkflow[] {
  return teams.filter(team => !team.deletedAt).flatMap(team => team.workflows ?? (
    team.projectId && team.workflowSteps ? [{
      id: team.id, teamId: team.id, projectId: team.projectId, name: team.name,
      workflowSteps: team.workflowSteps, enabled: team.enabled,
      createdAt: team.createdAt, updatedAt: team.updatedAt,
    }] : []
  )).filter(workflow => workflow.projectId === projectId);
}

export function workflowTeams(teams: readonly AgentTeam[], project: ProjectRecord): AgentTeam[] {
  const enabled = new Set(enabledProjectAgentIds(project));
  return teams.filter(team => !team.deletedAt && team.enabled && team.computerId === project.computerId
    && team.memberAgentIds.some(id => enabled.has(id)));
}


/** Projects where `userId` may give `team` a custom Workflow: their own
 *  open Projects on the Team's Computer with at least one enabled Project
 *  Agent from its roster, since every step needs an Agent in both rosters. */
export function workflowProjects(team: AgentTeam, projects: readonly ProjectRecord[], userId: string | undefined): ProjectRecord[] {
  if (!userId) return [];
  return projects
    .filter(project => project.ownerUserId === userId && project.enabled && !project.archivedAt && workflowTeams([team], project).length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function workflowInput(draft: WorkflowTeamDraft, projectId: string, enabled = true): WorkflowMutationInput {
  return {
    name: draft.name.trim(), projectId, enabled,
    workflowSteps: draft.steps.map(step => ({
      id: step.id, name: step.name.trim(), agentId: step.agentId,
      instructions: step.instructions.trim(), acceptanceCriteria: lines(step.acceptanceCriteria),
      requiresApproval: step.requiresApproval,
    })),
  };
}
