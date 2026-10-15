import type {
  SkillDetail,
  SkillFileInput,
  SkillFilePreview,
  SkillRecord,
  SkillsResponse,
  SkillVisibility,
} from "../types.ts";
import { apiJson } from "./client.ts";

export function listSkills(signal?: AbortSignal): Promise<SkillsResponse> { return apiJson("/skills", { signal }); }
export function getSkill(skillId: string, signal?: AbortSignal): Promise<SkillDetail> { return apiJson(`/skills/${encodeURIComponent(skillId)}`, { signal }); }
export function createSkill(input: { name: string; namespace?: string; displayName?: string; description?: string; visibility: SkillVisibility; source: "authored" | "upload"; files: SkillFileInput[] }): Promise<SkillRecord> { return apiJson("/skills", { method: "POST", body: input }); }
export function importSkill(input: { name: string; namespace?: string; displayName?: string; description?: string; visibility?: SkillVisibility; url: string; ref: string; subpath: string }): Promise<SkillRecord> { return apiJson("/skills/import", { method: "POST", body: input }); }
export function reimportSkill(skillId: string) { return apiJson(`/skills/${encodeURIComponent(skillId)}/import`, { method: "POST", body: {} }); }
export function reviseSkill(skillId: string, files: SkillFileInput[], note?: string) { return apiJson(`/skills/${encodeURIComponent(skillId)}/revisions`, { method: "POST", body: { files, ...(note ? { note } : {}) } }); }
export function updateSkill(skillId: string, patch: { displayName?: string; description?: string; visibility?: SkillVisibility }): Promise<SkillRecord> { return apiJson(`/skills/${encodeURIComponent(skillId)}`, { method: "PATCH", body: patch }); }
export function deleteSkill(skillId: string): Promise<void> { return apiJson(`/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" }); }
export function grantSkill(skillId: string, agentIds: string[], pin: "latest" | { revisionId: string } = "latest") { return apiJson<{ granted: unknown[] }>(`/skills/${encodeURIComponent(skillId)}/grants`, { method: "POST", body: { agentIds, pin } }); }
export function revokeSkill(skillId: string, agentId: string): Promise<void> { return apiJson(`/skills/${encodeURIComponent(skillId)}/grants/${encodeURIComponent(agentId)}`, { method: "DELETE" }); }
export function assignSkill(skillId: string, input: { targetType: "user" | "team" | "project" | "agent" | "org"; targetId: string; mode?: "optional" | "required" | "suggested"; pin?: "stable" | "latest" | { revisionId: string }; invocation?: "implicit" | "explicit" }) { return apiJson(`/skills/${encodeURIComponent(skillId)}/assignments`, { method: "POST", body: input }); }
export function revokeSkillAssignment(skillId: string, assignmentId: string): Promise<void> { return apiJson(`/skills/${encodeURIComponent(skillId)}/assignments/${encodeURIComponent(assignmentId)}`, { method: "DELETE" }); }
export function promoteSkillRevision(skillId: string, revisionId: string): Promise<SkillRecord> { return apiJson(`/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revisionId)}/promote`, { method: "POST", body: {} }); }
export function readSkillFile(skillId: string, path: string, channel: "stable" | "latest" = "stable", signal?: AbortSignal): Promise<SkillFilePreview> { return apiJson(`/skills/${encodeURIComponent(skillId)}/files?path=${encodeURIComponent(path)}&channel=${channel}`, { signal }); }
export function skillExportUrl(skillId: string, channel: "stable" | "latest" = "stable") { return `/api/v1/skills/${encodeURIComponent(skillId)}/export?channel=${channel}`; }
