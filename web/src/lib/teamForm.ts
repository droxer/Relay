import type { TeamMutationInput, TeamMemberConfig } from "../types.js";

export function teamMutationInput(input: {
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
    ...(input.memberConfigs ? { memberConfigs: Object.fromEntries(Object.entries(input.memberConfigs).filter(([id]) => input.memberAgentIds.includes(id)).map(([id, config]) => [id, { ...config, ...(config.expectedOutputs ? { expectedOutputs: config.expectedOutputs.map(value => value.trim()).filter(Boolean) } : {}) }])) } : {}),
    ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria.map(value => value.trim()).filter(Boolean) } : {}),
  };
}
