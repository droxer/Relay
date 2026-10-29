import type {
  AgentRole,
  ApplySetupTasksInput,
  ProjectRecord,
  ProjectSetup,
  ProjectSetupMemberIssue,
  ProjectSetupMode,
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
  /** The proposal's handle for the task; positional for older proposals. */
  key: string;
  /** Keys of earlier proposed tasks this one waits for. */
  after?: string[];
  /** Existing project tasks this one waits for. */
  afterTaskIds?: string[];
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
 *  setup agent returns its generated name. */
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

/** Whether an agent may draft for this project in `mode`. An existing
 *  (linked) project keeps the setup its owner gave it, so only planning is
 *  drafted for it; the backend refuses the rest (`project_setup_fresh_only`). */
export function setupDraftingAllowed(project: ProjectRecord, mode: ProjectSetupMode = "setup"): boolean {
  return mode === "plan" || !project.workspaceHostPath;
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
    tasks: (proposal.tasks ?? []).map((task, index) => ({
      ...task,
      key: task.key ?? `task-${index + 1}`,
      include: true,
    })),
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

/** The apply request for the tasks the owner kept. An assignee survives only
 *  when it is a member the owner kept (or, for a plan, a member already on
 *  the project); otherwise the task is filed unassigned. */
export function setupTasksApplyInput(
  draftId: string,
  draft: SetupDraft,
  memberIds: ReadonlySet<string>,
): ApplySetupTasksInput {
  const kept = draft.tasks.filter((task) => task.include && task.title.trim());
  return {
    draftId,
    taskKeys: kept.map((task) => task.key),
    assignedAgentIds: Object.fromEntries(kept.map((task) => [
      task.key,
      task.assignedAgentId && memberIds.has(task.assignedAgentId) ? task.assignedAgentId : null,
    ])),
  };
}

/** Titles of the kept tasks a proposed task waits for, in its order.
 *  A prerequisite the owner left out is dropped, as the apply drops it. */
export function setupTaskAfterTitles(task: SetupTaskDraft, tasks: readonly SetupTaskDraft[]): string[] {
  return (task.after ?? []).flatMap((key) => {
    const earlier = tasks.find((item) => item.key === key);
    return earlier?.include ? [earlier.title] : [];
  });
}

/** Kept members' ids, for the assignees a setup apply may carry. */
export function keptMemberIds(draft: SetupDraft): Set<string> {
  return new Set(draft.members.filter(memberKept).map((member) => member.agentId));
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
