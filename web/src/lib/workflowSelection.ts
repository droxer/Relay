import type { AgentTeam, CollaborationStyle, RelayTaskListItem } from "../types.ts";

export const PREDEFINED_WORKFLOWS = ["build_review", "pipeline", "lead_led"] as const;
export type WorkflowOption = { id: string; kind: "predefined" | "steps"; name?: string; projectId?: string; template?: CollaborationStyle; enabled: boolean };

export function predefinedStyle(id?: string | null): CollaborationStyle | undefined {
  return PREDEFINED_WORKFLOWS.find(style => id === `preset:${style}`);
}

export function defaultWorkflowId(team?: Pick<AgentTeam, "defaultWorkflowId" | "collaborationStyle" | "id" | "projectId" | "workflowSteps">): string {
  if (team?.defaultWorkflowId) return team.defaultWorkflowId;
  if (team?.projectId || team?.workflowSteps) return team.id;
  return `preset:${team?.collaborationStyle && team.collaborationStyle !== "solo" ? team.collaborationStyle : "build_review"}`;
}

export function workflowOptions(team?: Pick<AgentTeam, "workflows" | "workflowOptions">, projectId?: string): WorkflowOption[] {
  const catalog: WorkflowOption[] = team?.workflowOptions ?? [
    ...PREDEFINED_WORKFLOWS.map(template => ({ id: `preset:${template}`, kind: "predefined" as const, template, enabled: true })),
    ...(team?.workflows ?? []).map(workflow => ({ id: workflow.id, kind: "steps" as const, name: workflow.name, projectId: workflow.projectId, enabled: workflow.enabled })),
  ];
  return catalog.filter(option => option.kind === "predefined" || !projectId || option.projectId === projectId);
}

const presetId = (style: CollaborationStyle) => `preset:${style === "solo" ? "build_review" : style}`;

/** The Workflow a Task explicitly chose: its canonical selection, else its
 *  legacy style alias. Undefined means it inherits the Team default. */
export function explicitTaskWorkflowId(task: Pick<RelayTaskListItem, "assignedWorkflowId" | "collaborationStyle">): string | undefined {
  return task.assignedWorkflowId || (task.collaborationStyle ? presetId(task.collaborationStyle) : undefined);
}
