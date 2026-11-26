import type { TFunction } from "i18next";
import type { AgentTeam, ProjectListItem, UserAgent } from "../types.js";

export type AgentRoleIdentity = Pick<UserAgent, "defaultRole" | "roleLevel">;

export function agentRoleLabel(identity: AgentRoleIdentity | undefined, t: TFunction): string | undefined {
  if (!identity?.defaultRole) return undefined;
  const role = t(`admin.v2.agent_role.${identity.defaultRole}`, { defaultValue: identity.defaultRole });
  return identity.roleLevel ? `${t(`role_levels.${identity.roleLevel}`)} · ${role}` : role;
}

export function withProjectAgentRole(agent: UserAgent, project?: Pick<ProjectListItem, "members"> | null): UserAgent {
  const member = project?.members.find((item) => item.agentId === agent.id && item.enabled);
  return member ? { ...agent, defaultRole: member.role, roleLevel: member.roleLevel ?? agent.roleLevel } : agent;
}

export function withTeamAgentRole(agent: UserAgent, team?: AgentTeam): UserAgent {
  const config = team?.memberConfigs?.[agent.id];
  return config ? { ...agent, defaultRole: config.role ?? agent.defaultRole, roleLevel: config.roleLevel ?? agent.roleLevel } : agent;
}
