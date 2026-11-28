import type { AgentName, AgentRole, AgentRoleLevel, CollaborationStyle, DaemonAgentSkill, WorkflowStepDefinition } from "relay-core";

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

/** The placement fields shared by Team member routing and computer labels. */
export type AgentPlacementRoute = Pick<AgentPlacement,
  "id" | "daemonNodeId" | "runtimeNodeId" | "computerId" | "nodeDisplayName"
  | "desiredState" | "priority" | "nodeOwnership" | "nodeSandboxMode">;

/** The roles an agent may hold, in the order a Pipeline round takes them —
    the order every role picker offers. Mirrors AGENT_ROLES in
    relay/core/models.py; the AgentRole type that relay-core already owns
    keeps this list honest. */
export const AGENT_ROLE_OPTIONS: readonly AgentRole[] = [
  "researcher",
  "product_manager",
  "data",
  "planner",
  "designer",
  "implementer",
  "frontend_engineer",
  "backend_engineer",
  "fullstack_engineer",
  "fixer",
  "tester",
  "security",
  "performance",
  "writer",
  "devops",
  "operations",
  "reviewer",
];

export const AGENT_ROLE_LEVEL_OPTIONS: readonly AgentRoleLevel[] = [
  "junior",
  "senior",
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
  /** Absent/null permits all eligible agents; a list restricts targets. */
  delegationAgentIds?: string[] | null;
  /** The job this agent does on a team, e.g. "reviewer". Shapes its prompt and,
      for a reviewer, makes it review a round instead of redoing the work. */
  defaultRole?: AgentRole;
  /** Optional seniority level for the role ("junior" or "senior"). */
  roleLevel?: AgentRoleLevel | null;
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

export type AgentBadge = Pick<UserAgent, "id" | "displayName" | "profileImageUrl" | "executorKind" | "enabled" | "availability">;

/** Body for POST /agents — explicit agent creation (computer -> runtime -> role). */
export interface CreateAgentInput {
  computerId: string;
  executorKind: AgentName;
  defaultRole: AgentRole;
  roleLevel?: AgentRoleLevel;
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
  defaultAgentOffers?: DefaultAgentOffer[];
  view?: "summary";
  searchesInstructions?: boolean;
}

export type OnboardingAgentCandidate = Pick<UserAgent, "id" | "executorKind" | "enabled" | "availability" | "deletedAt"> & {
  placements: Pick<AgentPlacement, "daemonNodeId" | "runtimeNodeId" | "desiredState">[];
};

export type AgentSetupResponse = {
  view: "setup";
  onboardingAgents: OnboardingAgentCandidate[];
  defaultAgentOffers?: DefaultAgentOffer[];
} | UserAgentsResponse;

export interface DefaultAgentOffer {
  computerId: string;
  computerName: string;
  executorKinds: AgentName[];
}

export interface TeamMemberSummary {
  defaultRole?: AgentRole;
  roleLevel?: AgentRoleLevel | null;
  id: string;
  displayName: string;
  profileImageUrl?: string | null;
  executorKind: AgentName;
  enabled: boolean;
  availability: LogicalAgentAvailability;
  /** The selected Team preview carries routing information for its members. */
  placements?: AgentPlacementRoute[];
  computerId?: string;
}

export type TeamMemberChoice = TeamMemberSummary & { placements: AgentPlacementRoute[] };
export interface TeamMemberChoicesResponse {
  computerId: string;
  agents: TeamMemberChoice[];
}

export interface TeamMemberConfig {
  role?: AgentRole;
  roleLevel?: AgentRoleLevel;
  responsibility?: string;
  required?: boolean;
  participation?: "always" | "on_request";
  expectedOutputs?: string[];
}

export type TeamMemberConfigPatch = { [Key in keyof TeamMemberConfig]?: TeamMemberConfig[Key] | null };

/** A step as the editor and the Team write API carry it
 *  (`backend/relay/core/team_workflows.py`). */
export type WorkflowStep = WorkflowStepDefinition;

export interface AgentTeam {
  /** Revision of the Team record; optional on older servers. */
  version?: number;
  defaultWorkflowId?: string;
  projectWorkflowDefaults?: Record<string, string>;
  workflowOptions?: Array<{
    id: string;
    kind: "predefined" | "steps";
    name: string;
    projectId?: string | null;
    template?: CollaborationStyle;
    enabled: boolean;
    stepCount?: number;
    stepAgentIds?: string[];
    updatedAt?: string;
    version?: number;
  }>;
  workflows?: TeamWorkflow[];
  workflowPreviews?: TeamWorkflowPreview[];
  /** Set only on a Project workflow Team; immutable once set. */
  projectId?: string;
  /** The ordered steps of a Project workflow Team. A Team with steps never
   *  carries a collaboration style or the legacy human approval. */
  workflowSteps?: WorkflowStep[];
  /** Step count of a legacy Workflow Team in the roster summary. */
  workflowStepCount?: number;
  collaborationStyle?: CollaborationStyle;
  /** The team's person approves the work before its round's final step
   *  (ADR-023). Absent means no. */
  humanApproval?: boolean;
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
  view?: "summary";
}

export interface CompactTeamSummaryResponse {
  view: "summary";
  teams: (Omit<AgentTeam, "members" | "lead" | "workflowOptions"> & {
    workflowOptions: NonNullable<AgentTeam["workflowOptions"]>;
  })[];
  memberDirectory: TeamMemberSummary[];
  predefinedWorkflows: NonNullable<AgentTeam["workflowOptions"]>;
}

export type TeamRosterResponse = AgentTeamsResponse | CompactTeamSummaryResponse;

export interface TeamMutationInput {
  defaultWorkflowId?: string;
  projectId?: string;
  workflowSteps?: WorkflowStep[];
  collaborationStyle?: CollaborationStyle | null;
  humanApproval?: boolean;
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

/** A Project-, Team-, or standalone Computer-scoped Workflow definition. */
export interface Workflow {
  ownerTeamId?: string;
  id: string;
  ownerUserId?: string;
  projectId: string | null;
  computerId?: string | null;
  kind?: "steps" | "predefined";
  predefined?: {
    template: CollaborationStyle;
    memberAgentIds: string[];
    leadAgentId?: string | null;
    humanApproval?: boolean;
    acceptanceCriteria?: string[];
  };
  name: string;
  workflowSteps: WorkflowStep[];
  enabled: boolean;
  /** Persisted revision, absent on older backends. */
  version?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TeamWorkflow extends Workflow { teamId: string }

export type WorkflowStepPreview = Pick<WorkflowStep, "id" | "name" | "agentId" | "requiresApproval">;
export type WorkflowPreview = Omit<Workflow, "workflowSteps" | "ownerUserId"> & { workflowSteps: WorkflowStepPreview[] };
export type TeamWorkflowPreview = WorkflowPreview & { teamId: string };

export type ProjectWorkflowChoice = Pick<Workflow, "id" | "name" | "enabled"> & {
  projectId: string;
  stepAgentIds: string[];
};

export type StandaloneWorkflowChoice = Pick<Workflow, "id" | "name" | "enabled"> & {
  projectId: null;
  computerId: string;
  stepAgentIds: string[];
};

export type WorkflowMutationInput = Pick<Workflow, "name" | "projectId" | "workflowSteps" | "ownerTeamId" | "computerId"> & { enabled?: boolean };

export type WorkflowStepFields = Partial<Omit<WorkflowStep, "id" | "kind" | "expectedOutputs">> & {
  kind?: WorkflowStep["kind"] | null;
  expectedOutputs?: string[] | null;
};
export type WorkflowStepChanges = { byId?: Record<string, WorkflowStepFields>; order?: string[] };
export type WorkflowDraftUpdate = { name?: string; workflowStepChanges?: WorkflowStepChanges };
