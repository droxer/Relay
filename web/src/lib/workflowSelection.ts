import type { AgentTeam, CollaborationStyle, ProjectListItem, ProjectPredefinedTemplate, ProjectWorkflowChoice, RelayTaskListItem, StandaloneWorkflowChoice, UserAgent } from "../types.ts";

export const PREDEFINED_WORKFLOWS = ["build_review", "lead_led"] as const;
export const RETIRED_WORKFLOW_ID = "preset:pipeline";
export type WorkflowOption = {
  id: string;
  kind: "predefined" | "steps";
  name?: string;
  projectId?: string | null;
  template?: CollaborationStyle;
  enabled: boolean;
  stepAgentIds?: string[];
};

export function predefinedStyle(id?: string | null): CollaborationStyle | undefined {
  if (id === RETIRED_WORKFLOW_ID) return "pipeline";
  return PREDEFINED_WORKFLOWS.find(style => id === `preset:${style}`);
}

type ProjectPresetIssue = "project_roster_invalid" | "project_lead_required";
export type ProjectWorkflowIssue = ProjectPresetIssue | "unavailable_selection" | "workflow_retired";
type ProjectPreset = {
  id: string;
  kind: "predefined";
  template: typeof PREDEFINED_WORKFLOWS[number];
  issue: ProjectPresetIssue | null;
};
export type ProjectWorkflowOption = ProjectPreset | {
  id: string;
  kind: "steps";
  name: string;
  issue: null;
};

type PresetProject = Pick<ProjectListItem, "members" | "leadAgentId" | "predefinedWorkflows">;

/** Who takes part in a Predefined Workflow in this Project: the owner's
 *  selection limited to enabled Project Agents (every enabled Agent when none
 *  was made), plus the Lead for Lead-led. Mirrors projects/runtime.py. */
export function projectPresetParticipants(project: PresetProject, template: ProjectPredefinedTemplate): string[] {
  const enabled = project.members.filter(member => member.enabled).map(member => member.agentId);
  const selected = project.predefinedWorkflows?.[template]?.agentIds;
  if (!selected) return enabled;
  const chosen = new Set(selected);
  return enabled.filter(id => chosen.has(id) || (template === "lead_led" && id === project.leadAgentId));
}

export function projectWorkflowOptions(
  project: PresetProject & Pick<ProjectListItem, "id">,
  custom: readonly ProjectWorkflowChoice[] = [],
): ProjectWorkflowOption[] {
  const enabled = new Set(project.members.filter(member => member.enabled).map(member => member.agentId));
  const presets: ProjectPreset[] = PREDEFINED_WORKFLOWS.map(template => ({
    id: `preset:${template}`, kind: "predefined", template,
    issue: !projectPresetParticipants(project, template).length ? "project_roster_invalid"
      : template === "lead_led" && (!project.leadAgentId || !enabled.has(project.leadAgentId)) ? "project_lead_required"
      : null,
  }));
  return [
    ...presets,
    ...custom.filter(workflow => workflow.projectId === project.id && workflow.enabled
      && workflow.stepAgentIds.every(id => enabled.has(id)))
      .map(({ id, name }): ProjectWorkflowOption => ({ id, name, kind: "steps", issue: null })),
  ];
}

export type StandaloneWorkflowOption = {
  id: string;
  kind: "steps";
  name: string;
  computerId: string;
  stepAgentIds: string[];
  issue: null;
};

function agentActiveOnComputer(
  agent: Pick<UserAgent, "enabled" | "deletedAt" | "placements">,
  computerId: string,
): boolean {
  if (agent.enabled === false || agent.deletedAt) return false;
  return (agent.placements ?? []).some(
    (placement) => placement.desiredState !== "removed" && placement.computerId === computerId,
  );
}

/** Standalone Workflows eligible for an independent Task (optionally scoped to
 *  the Task's Computer, and verified against live Agents when provided). */
export function standaloneWorkflowOptions(
  custom: readonly StandaloneWorkflowChoice[] = [],
  computerId?: string | null,
  agents?: readonly Pick<UserAgent, "id" | "enabled" | "deletedAt" | "placements">[],
): StandaloneWorkflowOption[] {
  const agentMap = agents ? new Map(agents.map((agent) => [agent.id, agent])) : null;
  return custom
    .filter((workflow) => {
      if (!workflow.enabled || workflow.projectId !== null || !workflow.computerId) return false;
      if (computerId && workflow.computerId !== computerId) return false;
      if (!agentMap) return true;
      return workflow.stepAgentIds.length > 0 && workflow.stepAgentIds.every((id) => {
        const agent = agentMap.get(id);
        return Boolean(agent && agentActiveOnComputer(agent, workflow.computerId));
      });
    })
    .map(({ id, name, computerId: wfComputerId, stepAgentIds }): StandaloneWorkflowOption => ({
      id, name, kind: "steps", computerId: wfComputerId, stepAgentIds, issue: null,
    }));
}

export function standaloneWorkflowSelectionIssue(
  id: string,
  options: readonly StandaloneWorkflowOption[],
): ProjectWorkflowIssue | null {
  if (id === RETIRED_WORKFLOW_ID) return "workflow_retired";
  return options.some((item) => item.id === id) ? null : "unavailable_selection";
}

export function projectWorkflowSelectionIssue(
  id: string, options: readonly ProjectWorkflowOption[],
): ProjectWorkflowIssue | null {
  if (id === RETIRED_WORKFLOW_ID) return "workflow_retired";
  const option = options.find(item => item.id === id);
  return option ? option.issue : "unavailable_selection";
}

export function projectWorkflowName(id: string, t: (key: string) => string, customName?: string): string | undefined {
  if (id === RETIRED_WORKFLOW_ID) return t("workflow.pipeline_retired");
  const style = predefinedStyle(id);
  return style ? t(`collab_style.${style}`) : customName;
}

export function teamWorkflowPreviews(team: Pick<AgentTeam, "workflows" | "workflowPreviews">) {
  return team.workflowPreviews ?? team.workflows ?? [];
}

export function teamWorkflowName(team: Pick<AgentTeam, "workflows" | "workflowOptions"> | undefined, id?: string | null) {
  if (!id) return undefined;
  return team?.workflowOptions?.find(item => item.id === id)?.name ?? team?.workflows?.find(item => item.id === id)?.name;
}

export function defaultWorkflowId(team?: Pick<AgentTeam, "defaultWorkflowId" | "collaborationStyle" | "id" | "projectId" | "workflowSteps" | "projectWorkflowDefaults">, projectId?: string): string {
  if (projectId && team?.projectWorkflowDefaults?.[projectId]) return team.projectWorkflowDefaults[projectId];
  if (team?.defaultWorkflowId) return team.defaultWorkflowId;
  if (team?.projectId || team?.workflowSteps) return team.id;
  return `preset:${team?.collaborationStyle && team.collaborationStyle !== "solo" ? team.collaborationStyle : "build_review"}`;
}

export function workflowOptions(team?: Pick<AgentTeam, "workflows" | "workflowOptions">, projectId?: string): WorkflowOption[] {
  const catalog: WorkflowOption[] = team?.workflowOptions ?? [
    ...PREDEFINED_WORKFLOWS.map(template => ({ id: `preset:${template}`, kind: "predefined" as const, template, enabled: true })),
    ...(team?.workflows ?? []).map(workflow => ({ id: workflow.id, kind: "steps" as const, name: workflow.name, projectId: workflow.projectId, enabled: workflow.enabled })),
  ];
  return catalog.filter(option => option.id !== RETIRED_WORKFLOW_ID
    && (option.kind === "predefined" || !projectId || !option.projectId || option.projectId === projectId));
}

/** Task/Automation choices must resolve in their Project before submission. */
export function workflowSelectionIssue(team: AgentTeam | undefined, value: string | null, projectId?: string, projectAgentIds?: readonly string[]): "project" | "unavailable" | "workflow_retired" | null {
  if (!team) return null;
  const selected = value || defaultWorkflowId(team, projectId);
  if (selected === RETIRED_WORKFLOW_ID) return "workflow_retired";
  const option = workflowOptions(team).find(item => item.id === selected);
  if (!option || !option.enabled) return "unavailable";
  if (option.kind === "steps" && (!projectId || (option.projectId && option.projectId !== projectId))) return "project";
  return projectAgentIds && !workflowParticipantsAllowed(team, selected, projectAgentIds) ? "unavailable" : null;
}

/** A custom process may use a subset of the roster; presets use Team roles. */
export function workflowParticipantsAllowed(team: AgentTeam | undefined, id: string, projectAgentIds: readonly string[]): boolean {
  if (!team) return false;
  const participants = predefinedStyle(id)
    ? team.memberAgentIds
    : team.workflowOptions?.find(item => item.id === id)?.stepAgentIds
    ?? (team.workflows?.find(item => item.id === id)?.workflowSteps
      ?? (id === team.id ? team.workflowSteps : undefined))?.map(step => step.agentId);
  return Boolean(participants?.length && participants.every(agentId => projectAgentIds.includes(agentId)
    && team.memberAgentIds.includes(agentId)));
}

const presetId = (style: CollaborationStyle) => `preset:${style === "solo" ? "build_review" : style}`;

/** The Workflow a Task explicitly chose: its canonical selection, else its
 *  legacy style alias. Undefined means it inherits the Team default. */
export function explicitTaskWorkflowId(task: Pick<RelayTaskListItem, "assignedWorkflowId" | "collaborationStyle">): string | undefined {
  return task.assignedWorkflowId || (task.collaborationStyle ? presetId(task.collaborationStyle) : undefined);
}
