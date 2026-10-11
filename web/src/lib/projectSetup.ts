import type {
  AgentRole,
  CreateTaskInput,
  ProjectRecord,
  ProjectSetup,
  ProjectSetupMemberIssue,
  ProjectSetupProposal,
  UpdateProjectInput,
} from "../types.ts";

/** Longest provisional name; the backend caps names at 120. */
const PROVISIONAL_NAME_MAX = 60;

export interface SetupMemberDraft {
  agentId: string;
  role: AgentRole;
  responsibilities: string;
  instructions?: string;
  include: boolean;
  issue?: ProjectSetupMemberIssue;
}

export interface SetupTaskDraft {
  title: string;
  description?: string;
  assignedAgentId?: string;
  include: boolean;
}

/** The owner's working copy of a proposal: every field editable, every
 *  member and task individually opt-out. */
export interface SetupDraft {
  name: string;
  goal: string;
  description: string;
  context: string;
  leadAgentId: string | null;
  members: SetupMemberDraft[];
  tasks: SetupTaskDraft[];
}

/** A project needs a unique name before its setup agent can name it. The
 *  first line of the intent, clipped on a word boundary, stands in until the
 *  owner applies the proposal. */
export function provisionalProjectName(intent: string, fallback: string): string {
  const line = intent.split(/\r?\n/).map((part) => part.trim()).find(Boolean) ?? "";
  const words = line.replace(/\s+/g, " ").replace(/[.!?。！？]+$/u, "");
  if (!words) return fallback;
  if (words.length <= PROVISIONAL_NAME_MAX) return words;
  const clipped = words.slice(0, PROVISIONAL_NAME_MAX);
  const boundary = clipped.lastIndexOf(" ");
  return `${(boundary > PROVISIONAL_NAME_MAX / 2 ? clipped.slice(0, boundary) : clipped).trim()}…`;
}

/** The setup states the review panel shows; resolved setups stay out of the way. */
export function setupNeedsAttention(setup: ProjectSetup | undefined | null): setup is ProjectSetup {
  return Boolean(setup && (setup.state === "drafting" || setup.state === "proposed" || setup.state === "failed"));
}

/** Members an Apply would refuse arrive unchecked, so the default Apply
 *  succeeds; the owner can still see why each was left out. */
export function setupDraftFromProposal(proposal: ProjectSetupProposal, project: ProjectRecord): SetupDraft {
  const members = (proposal.members ?? []).map((member) => ({
    agentId: member.agentId,
    role: member.role,
    responsibilities: member.responsibilities,
    ...(member.instructions ? { instructions: member.instructions } : {}),
    include: !member.issue,
    ...(member.issue ? { issue: member.issue } : {}),
  }));
  return {
    name: proposal.name ?? project.name,
    goal: proposal.goal ?? project.goal ?? "",
    description: proposal.description ?? project.description ?? "",
    context: proposal.context ?? project.context ?? "",
    leadAgentId: effectiveLead(members, proposal.leadAgentId ?? null),
    members,
    tasks: (proposal.tasks ?? []).map((task) => ({ ...task, include: true })),
  };
}

/** The lead must be a kept member; otherwise the first kept one. */
export function effectiveLead(members: readonly SetupMemberDraft[], leadAgentId: string | null): string | null {
  const kept = members.filter(memberKept);
  if (kept.some((member) => member.agentId === leadAgentId)) return leadAgentId;
  return kept[0]?.agentId ?? null;
}

/** One PATCH applies the proposal: the brief, the roster, and the setup's
 *  closing, so the project never shows a half-applied setup. The roster is
 *  sent only when the owner kept at least one member; an empty selection
 *  leaves the current roster alone. */
export function setupApplyInput(project: ProjectRecord, draft: SetupDraft): UpdateProjectInput {
  const members = draft.members.filter(memberKept).map(({ agentId, role, responsibilities, instructions }) => ({
    agentId,
    role,
    responsibilities: responsibilities.trim(),
    ...(instructions?.trim() ? { instructions: instructions.trim() } : {}),
    enabled: true,
  }));
  const name = draft.name.trim();
  return {
    expectedVersion: project.version,
    ...(name && name !== project.name ? { name } : {}),
    ...changed("goal", draft.goal, project.goal),
    ...changed("description", draft.description, project.description),
    ...changed("context", draft.context, project.context),
    ...(members.length ? { members, leadAgentId: effectiveLead(draft.members, draft.leadAgentId) } : {}),
    setupResolution: "applied",
  };
}

/** The tasks the owner kept, filed into the project. An assignee survives
 *  only when it is a member the owner kept. */
export function setupTaskInputs(project: ProjectRecord, draft: SetupDraft): CreateTaskInput[] {
  const kept = new Set(draft.members.filter(memberKept).map((member) => member.agentId));
  return draft.tasks
    .filter((task) => task.include && task.title.trim())
    .map((task) => ({
      title: task.title.trim(),
      projectId: project.id,
      ...(task.description?.trim() ? { description: task.description.trim() } : {}),
      ...(task.assignedAgentId && kept.has(task.assignedAgentId) ? { assignedAgentId: task.assignedAgentId } : {}),
    }));
}

/** A member Apply would carry: kept by the owner, with nothing blocking it,
 *  and an outcome contract the roster requires. */
export function memberKept(member: SetupMemberDraft): boolean {
  return member.include && !member.issue && Boolean(member.responsibilities.trim());
}

function changed<K extends "goal" | "description" | "context">(key: K, draft: string, saved: string | undefined) {
  const next = draft.trim();
  return next !== (saved ?? "").trim() ? { [key]: next } as Record<K, string> : {};
}
