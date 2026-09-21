import type { ProjectMember, ProjectRecord, UpdateProjectInput } from "../types";

export interface ProjectEditConflict {
  field: string;
  member?: string;
  saved: string;
  draft: string;
}

export class ProjectEditError extends Error {}

const memberFields = ["role", "functionTitle", "responsibilities", "instructions", "enabled"] as const;
const labels: Record<string, string> = {
  functionTitle: "function_title", leadAgentId: "lead", enabled: "member_enabled",
};

function normalizeMember(member: NonNullable<UpdateProjectInput["members"]>[number]): ProjectMember {
  const { instructions, ...rest } = member;
  return { ...rest, enabled: member.enabled ?? true, ...(instructions ? { instructions } : {}) };
}

/** Reapply only the user's changes onto a freshly fetched revision. */
export function rebaseProjectEdit(base: ProjectRecord, input: UpdateProjectInput, latest: ProjectRecord) {
  if (latest.id !== base.id || latest.archivedAt || latest.enabled === false) {
    throw new ProjectEditError("project.edit_closed");
  }
  const conflicts: ProjectEditConflict[] = [];
  const patch: UpdateProjectInput = { expectedVersion: latest.version };
  function mergeFields<T extends object, K extends keyof T>(
    before: T, desired: T, current: T, fields: readonly K[], member?: string,
  ): T {
    const merged = { ...current };
    for (const field of fields) {
      if (desired[field] === before[field]) continue;
      if (current[field] !== before[field] && current[field] !== desired[field]) {
        conflicts.push({ field: labels[String(field)] ?? String(field), member,
          saved: String(current[field] ?? ""), draft: String(desired[field] ?? "") });
      }
      merged[field] = desired[field];
    }
    return merged;
  }
  const desiredProject = { ...base, ...input };
  const mergedProject = mergeFields(base, desiredProject as ProjectRecord, latest, ["name", "leadAgentId", "enabled"]);
  for (const field of ["name", "leadAgentId", "enabled"] as const) {
    if (field in input) Object.assign(patch, { [field]: mergedProject[field] });
  }
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
        ? mergeFields(original, member, saved, memberFields, member.functionTitle)
        : member);
    }
    for (const [id, original] of before) {
      if (desired.has(id)) continue;
      const saved = current.get(id);
      if (saved && memberFields.some((field) => saved[field] !== original[field])) {
        conflicts.push({ field: "member_remove", member: saved.functionTitle,
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
