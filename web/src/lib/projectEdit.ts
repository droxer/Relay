import type { ProjectMember, ProjectMemberChange, ProjectRecord, UpdateProjectInput } from "../types";

interface ProjectEditConflict {
  field: string;
  member?: string;
  saved: string;
  draft: string;
}

export class ProjectEditError extends Error {}

const projectFields = ["name", "description", "goal", "context", "leadAgentId", "enabled"] as const;
const memberFields = ["role", "roleLevel", "responsibilities", "instructions", "enabled"] as const;
const labels: Record<string, string> = {
  leadAgentId: "member_make_lead", enabled: "member_enabled",
};

function normalizeMember(member: NonNullable<UpdateProjectInput["members"]>[number]): ProjectMember {
  const { instructions, roleLevel, ...rest } = member;
  return { ...rest, enabled: member.enabled ?? true, ...(roleLevel ? { roleLevel } : {}), ...(instructions ? { instructions } : {}) };
}

/** The member editor works with a roster draft for validation and rebasing.
 *  The request carries the selected member's changes against that revision. */
export function projectMemberPatch(base: ProjectRecord, input: UpdateProjectInput, agentId: string): UpdateProjectInput {
  const { members, leadAgentId, ...fieldsToUpdate } = input;
  const patch: UpdateProjectInput = fieldsToUpdate;
  if (leadAgentId !== undefined && leadAgentId !== base.leadAgentId) patch.leadAgentId = leadAgentId;
  const previous = base.members.find(member => member.agentId === agentId);
  const desired = members?.find(member => member.agentId === agentId);
  if (!members) return patch;

  if (!desired) {
    if (previous) patch.memberChange = { op: "remove", agentId };
  } else if (!previous) {
    const { role, roleLevel, responsibilities, instructions, enabled } = normalizeMember(desired);
    patch.memberChange = {
      op: "add", agentId, fields: {
        role, responsibilities, enabled, ...(roleLevel ? { roleLevel } : {}), ...(instructions ? { instructions } : {}),
      },
    };
  } else {
    const next = normalizeMember(desired);
    const fields: Extract<ProjectMemberChange, { op: "update" }>["fields"] = {
      ...(next.role !== previous.role ? { role: next.role } : {}),
      ...(next.roleLevel !== (previous.roleLevel ?? undefined) ? { roleLevel: next.roleLevel ?? null } : {}),
      ...(next.responsibilities.trim() !== previous.responsibilities.trim() ? { responsibilities: next.responsibilities } : {}),
      ...(next.enabled !== previous.enabled ? { enabled: next.enabled } : {}),
      ...((next.instructions?.trim() ?? "") !== (previous.instructions?.trim() ?? "") ? { instructions: next.instructions ?? null } : {}),
    };
    if (Object.keys(fields).length) patch.memberChange = { op: "update", agentId, fields };
  }
  return patch;
}

/** Reapply only the user's changes onto a freshly fetched revision. */
export function rebaseProjectEdit(base: ProjectRecord, input: UpdateProjectInput, latest: ProjectRecord, memberNames: Record<string, string> = {}) {
  if (latest.id !== base.id || latest.archivedAt || latest.enabled === false) {
    throw new ProjectEditError("project.edit_closed");
  }
  const conflicts: ProjectEditConflict[] = [];
  const patch: UpdateProjectInput = { expectedVersion: latest.version };
  function displayValue(field: string, value: unknown): string {
    if (field === "leadAgentId" && value) {
      return memberNames[String(value)] ?? String(value);
    }
    return String(value ?? "");
  }
  function mergeFields<T extends object, K extends keyof T>(
    before: T, desired: T, current: T, fields: readonly K[], member?: string,
  ): T {
    const merged = { ...current };
    for (const field of fields) {
      if (desired[field] === before[field]) continue;
      if (current[field] !== before[field] && current[field] !== desired[field]) {
        conflicts.push({ field: labels[String(field)] ?? String(field), member,
          saved: displayValue(String(field), current[field]), draft: displayValue(String(field), desired[field]) });
      }
      merged[field] = desired[field];
    }
    return merged;
  }
  /* Projects created before the brief fields existed carry none; read them
     as empty so an untouched brief is never mistaken for an edit. */
  const withDescription = (project: ProjectRecord): ProjectRecord => ({
    ...project,
    description: project.description ?? "",
    goal: project.goal ?? "",
    context: project.context ?? "",
  });
  const desiredProject = withDescription({ ...base, ...input } as ProjectRecord);
  const mergedProject = mergeFields(withDescription(base), desiredProject, withDescription(latest), projectFields);
  for (const field of projectFields) {
    if (field in input) Object.assign(patch, { [field]: mergedProject[field] });
  }
  // Resolving a suggestion is idempotent: one already gone is simply skipped.
  if (input.resolveContextSuggestions) patch.resolveContextSuggestions = input.resolveContextSuggestions;
  if (input.members) {
    const before = new Map(base.members.map((member) => [member.agentId, normalizeMember(member)]));
    const desired = new Map(input.members.map((member) => [member.agentId, normalizeMember(member)]));
    const current = new Map(latest.members.map((member) => [member.agentId, normalizeMember(member)]));
    for (const [id, member] of desired) {
      const original = before.get(id);
      const saved = current.get(id);
      if (original && !saved) {
        if (memberFields.some((field) => member[field] !== original[field])) {
          throw new ProjectEditError("project.edit_member_removed");
        }
        continue; // An unedited sibling was removed; keep that removal.
      }
      if (!original && saved) throw new ProjectEditError("project.edit_member_added");
      current.set(id, original && saved
        ? mergeFields(original, member, saved, memberFields, memberNames[member.agentId] ?? member.agentId)
        : member);
    }
    for (const [id, original] of before) {
      if (desired.has(id)) continue;
      const saved = current.get(id);
      if (saved && memberFields.some((field) => saved[field] !== original[field])) {
        conflicts.push({ field: "member_remove", member: memberNames[saved.agentId] ?? saved.agentId,
          saved: memberFields.map((field) => String(saved[field] ?? "")).join(" · "), draft: "" });
      }
      current.delete(id);
    }
    patch.members = [...current.values()].map(normalizeMember);
    const lead = patch.leadAgentId === undefined ? latest.leadAgentId : patch.leadAgentId;
    if (patch.members.length && !patch.members.some((member) => member.agentId === lead && member.enabled)) {
      throw new ProjectEditError("project.member_lead_required");
    }
    if (!patch.members.length) patch.leadAgentId = null;
  }
  return { patch, conflicts };
}
