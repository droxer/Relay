import type { CollaborationStyle, TeamMutationInput, TeamMemberConfig } from "../types.js";

/** Drop members who are no longer on the team, and strip blank output lines. */
export function normalizeMemberConfigs(
  configs: Record<string, TeamMemberConfig>,
  memberAgentIds: string[],
): Record<string, TeamMemberConfig> {
  return Object.fromEntries(
    Object.entries(configs)
      .filter(([id]) => memberAgentIds.includes(id))
      .map(([id, config]) => [id, {
        ...config,
        ...(config.expectedOutputs
          ? { expectedOutputs: config.expectedOutputs.map((value) => value.trim()).filter(Boolean) }
          : {}),
      }]),
  );
}

export function normalizeAcceptanceCriteria(criteria: string[]): string[] {
  return criteria.map((value) => value.trim()).filter(Boolean);
}

export function teamMutationInput(input: {
  collaborationStyle?: CollaborationStyle | null;
  name: string;
  leadAgentId: string;
  memberAgentIds: string[];
  enabled: boolean;
  memberConfigs?: Record<string, TeamMemberConfig>;
  acceptanceCriteria?: string[];
}): TeamMutationInput {
  return {
    name: input.name.trim(),
    leadAgentId: input.leadAgentId,
    memberAgentIds: input.memberAgentIds,
    enabled: input.enabled,
    ...(input.collaborationStyle !== undefined ? { collaborationStyle: input.collaborationStyle } : {}),
    ...(input.memberConfigs
      ? { memberConfigs: normalizeMemberConfigs(input.memberConfigs, input.memberAgentIds) }
      : {}),
    ...(input.acceptanceCriteria
      ? { acceptanceCriteria: normalizeAcceptanceCriteria(input.acceptanceCriteria) }
      : {}),
  };
}

/* Object key order is an artifact of which field the user touched first
   (`{role, required}` vs `{required, role}`), so comparing raw JSON.stringify
   marked a form dirty with no actual change and fired the unsaved-changes
   guard. Sort keys for the comparison only — the saved payload keeps its own
   shape. Array order is preserved: criteria lines are user-ordered. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, canonical(entry)]);
  }
  return value;
}

/** Has the work-contract half of a team form changed? Compares the NORMALIZED
 *  values, so a trailing blank line or a config for a removed member — both of
 *  which `teamMutationInput` strips before saving — never reads as dirty. */
export function teamContractChanged(
  draft: { memberConfigs: Record<string, TeamMemberConfig>; acceptanceCriteria: string[] },
  saved: { memberConfigs?: Record<string, TeamMemberConfig>; acceptanceCriteria?: string[] },
  memberAgentIds: string[],
): boolean {
  const same = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
  return !same(
    normalizeMemberConfigs(draft.memberConfigs, memberAgentIds),
    normalizeMemberConfigs(saved.memberConfigs ?? {}, memberAgentIds),
  ) || !same(
    normalizeAcceptanceCriteria(draft.acceptanceCriteria),
    normalizeAcceptanceCriteria(saved.acceptanceCriteria ?? []),
  );
}
