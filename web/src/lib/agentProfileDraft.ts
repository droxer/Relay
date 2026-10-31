/**
 * The editable part of an agent's profile — name, role, model, instructions —
 * as one draft, saved together in one PATCH. Every field compares trimmed so
 * stray whitespace never reads as an unsaved change.
 */
import type { AgentRole } from "../types.ts";
import { agentModel, modelPolicyFor } from "./agentModels.ts";

export interface AgentProfileDraft {
  name: string;
  role: AgentRole | "";
  /** The pinned model id, or "" for the runtime default. */
  model: string;
  instructions: string;
}

export interface AgentProfilePatch {
  displayName?: string;
  defaultRole?: AgentRole;
  modelPolicy?: { model?: string };
  instructions?: string;
}

interface DraftSource {
  displayName: string;
  defaultRole?: AgentRole | null;
  modelPolicy?: Record<string, unknown>;
  instructions?: string | null;
}

export function profileDraftOf(agent: DraftSource): AgentProfileDraft {
  return {
    name: agent.displayName,
    role: agent.defaultRole ?? "",
    model: agentModel(agent),
    instructions: agent.instructions ?? "",
  };
}

/** Only the fields the draft changes; an empty object means nothing to save. */
export function profileDraftPatch(saved: AgentProfileDraft, draft: AgentProfileDraft): AgentProfilePatch {
  const name = draft.name.trim();
  const model = draft.model.trim();
  const instructions = draft.instructions.trim();
  return {
    ...(name !== saved.name.trim() ? { displayName: name } : {}),
    ...(draft.role && draft.role !== saved.role ? { defaultRole: draft.role } : {}),
    ...(model !== saved.model.trim() ? { modelPolicy: modelPolicyFor(model) } : {}),
    ...(instructions !== saved.instructions.trim() ? { instructions } : {}),
  };
}

export function profileDraftDirty(saved: AgentProfileDraft, draft: AgentProfileDraft): boolean {
  return Object.keys(profileDraftPatch(saved, draft)).length > 0;
}
