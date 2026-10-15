import type { AgentName, AgentRole, CollaborationStyle, DaemonAgentSkill } from "relay-core";

export type LogicalAgentAvailability = "ready" | "busy" | "pending" | "offline";

export interface AgentPlacement {
  id: string;
  agentId: string;
  userId: string;
  /** Runtime node observed when the placement was created (audit only). */
  daemonNodeId: string;
  /** Current runtime node resolved through the placement's stable Computer. */
  runtimeNodeId?: string;
  /** Stable Computer identity; runtime node IDs may be replaced. */
  computerId?: string;
  managedNodeId?: string;
  nodeDisplayName?: string;
  nodeOwnership?: "managed" | "user-device" | "unknown";
  nodeSandboxMode?: "boxlite" | "none";
  executorKind: AgentName;
  desiredState: "active" | "draining" | "removed";
  status: "pending" | "ready" | "busy" | "offline" | "incompatible" | "failed";
  priority: number;
  agentVersion: number;
  workspacePolicy: Record<string, unknown>;
  conditions: Array<{ reason: string; message: string }>;
  createdAt: string;
  updatedAt: string;
}

/** The roles an agent may hold on a team, in the order they are offered.
    Mirrors AGENT_ROLES in relay/core/models.py; the AgentRole type that
    relay-core already owns keeps this list honest. */
export const AGENT_ROLE_OPTIONS: readonly AgentRole[] = [
  "implementer",
  "reviewer",
  "planner",
  "tester",
  "fixer",
];

/** Why an agent cannot currently run, derived live on every read — never
    persisted. "available" means the agent's computer and runtime are both
    present and reachable. */
export type AgentBindingStatus =
  | "available"
  | "computer_gone"
  | "computer_offline"
  | "runtime_missing";

export interface UserAgent {
  id: string;
  /** The user who supervises this agent. `/agents` is already scoped to
      the caller, and records that predate supervision carry no owner at all,
      so this is optional — an agent without one is globally assignable. */
  supervisorUserId?: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  instructions?: string;
  /** The job this agent does on a team, e.g. "reviewer". Shapes its prompt and,
      for a reviewer, makes it review a round instead of redoing the work. */
  defaultRole?: AgentRole;
  skillPolicy: Record<string, unknown>;
  toolPolicy: Record<string, unknown>;
  modelPolicy: Record<string, unknown>;
  /** False when the daemon the agent runs on is too old to pass a model on. */
  canSelectModel?: boolean;
  /** True when the agent's runtime calls a custom model endpoint on its node,
      so vendor model ids may not exist there. */
  customModelEndpoint?: boolean;
  /** Model ids this agent's runtime reports on the computers it runs on.
      Node-reported and resolved on read, like skills. */
  availableModels?: string[];
  /** Skills installed for this agent's runtime on the computers it runs on.
      Node-reported inventory resolved on read, never a stored agent field. */
  skills?: DaemonAgentSkill[];
  enabled: boolean;
  version: number;
  availability: LogicalAgentAvailability;
  placements: AgentPlacement[];
  /** The computer this agent was explicitly created on. */
  computerId?: string;
  bindingStatus?: AgentBindingStatus;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

/** Body for POST /agents — explicit agent creation (computer -> runtime -> role). */
export interface CreateAgentInput {
  computerId: string;
  executorKind: AgentName;
  defaultRole: AgentRole;
  displayName?: string;
  instructions?: string;
  /** Omitted (or `{}`) runs the runtime's default model. */
  modelPolicy?: { model?: string };
  /** A preset from `lib/presetAvatars.ts`; uploads happen after creation. */
  profileImageUrl?: string;
}

export interface CreateAgentResponse {
  agent: UserAgent;
}

export interface UserAgentsResponse {
  agents: UserAgent[];
}

export interface TeamMemberSummary {
  defaultRole?: AgentRole;
  id: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  enabled: boolean;
  availability: LogicalAgentAvailability;
}

export interface TeamMemberConfig {
  role?: "planner" | "implementer" | "tester" | "reviewer" | "fixer";
  responsibility?: string;
  required?: boolean;
  participation?: "always" | "on_request";
  expectedOutputs?: string[];
}

export interface AgentTeam {
  collaborationStyle?: CollaborationStyle;
  id: string;
  ownerUserId: string;
  name: string;
  profileImageUrl?: string | null;
  leadAgentId?: string | null;
  memberAgentIds: string[];
  /** The computer the whole roster lives on. Absent on a team saved before
   *  teams carried one; `teamComputerId` derives it from the roster. */
  computerId?: string;
  memberConfigs?: Record<string, TeamMemberConfig>;
  acceptanceCriteria?: string[];
  enabled: boolean;
  members: TeamMemberSummary[];
  lead?: TeamMemberSummary | null;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface AgentTeamsResponse {
  teams: AgentTeam[];
}

export interface TeamMutationInput {
  collaborationStyle?: CollaborationStyle | null;
  memberConfigs?: Record<string, TeamMemberConfig>;
  acceptanceCriteria?: string[];
  name: string;
  leadAgentId: string;
  memberAgentIds: string[];
  /** Pins the team to one computer; every member must be placed on it. */
  computerId?: string;
  enabled?: boolean;
  /** A preset from `lib/presetAvatars.ts`; only sent when creating a team. */
  profileImageUrl?: string;
}
