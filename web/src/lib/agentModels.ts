/**
 * Which LLM an agent's runtime runs. `modelPolicy` is `{}` for the runtime's
 * own default or `{ model }` to pin one; the daemon passes the id to the
 * runtime CLI's model flag.
 *
 * The suggestions are a shortcut, not an allowlist: catalogs move faster than
 * this file and Pi/Kimi models depend on the provider configured on the
 * computer, so any well-formed id can be entered as a custom model. The shape
 * rule mirrors backend/relay/core/model_policy.py.
 */
import type { AgentName } from "../types.ts";

export const MODEL_ID_MAX_LENGTH = 128;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@[\]+-]*$/;

export const SUGGESTED_MODELS: Readonly<Record<AgentName, readonly string[]>> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"],
  codex: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1"],
  pi: [],
  kimi: [],
};

export function suggestedModels(kind: AgentName | "" | undefined): readonly string[] {
  return kind ? SUGGESTED_MODELS[kind] ?? [] : [];
}

/** The model an agent pins, or "" when it uses the runtime default. */
export function agentModel(agent: { modelPolicy?: Record<string, unknown> }): string {
  const model = agent.modelPolicy?.model;
  return typeof model === "string" ? model.trim() : "";
}

export function modelPolicyFor(model: string): { model?: string } {
  const trimmed = model.trim();
  return trimmed ? { model: trimmed } : {};
}

export type ModelIdProblem = "too_long" | "invalid";

/** Why a typed model id would be refused, or null when it is acceptable. Blank means default. */
export function modelIdProblem(model: string): ModelIdProblem | null {
  const trimmed = model.trim();
  if (!trimmed) return null;
  if (trimmed.length > MODEL_ID_MAX_LENGTH) return "too_long";
  return MODEL_ID.test(trimmed) ? null : "invalid";
}
