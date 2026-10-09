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
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-5-5"],
  codex: ["gpt-5.1-codex", "gpt-5.1-codex-mini", "gpt-5.1"],
  pi: [],
  kimi: [],
};

/**
 * Vendor ids to offer for `kind`. None behind a custom endpoint: a proxy or
 * compatible provider serves its own catalog, so a vendor id would only fail
 * when the run starts.
 */
export function suggestedModels(
  kind: AgentName | "" | undefined,
  { customEndpoint = false }: { customEndpoint?: boolean } = {},
): readonly string[] {
  if (!kind || customEndpoint) return [];
  return SUGGESTED_MODELS[kind] ?? [];
}

/**
 * The i18n key explaining what to enter for `kind`. Pi picks the provider
 * from a qualified id ("openai/gpt-5"); a custom endpoint needs an id it serves.
 */
export function modelHintKey(
  kind: AgentName | "" | undefined,
  { customEndpoint = false }: { customEndpoint?: boolean } = {},
): string {
  if (customEndpoint) return "agents_page.model_hint_custom_endpoint";
  if (kind === "pi") return "agents_page.model_hint_pi";
  return "agents_page.model_hint";
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
