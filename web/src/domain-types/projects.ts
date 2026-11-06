import type { AgentRole } from "relay-core";
/** What a member does in the Project's rounds; managing it is `projectManager`. */
export type ProjectRole = AgentRole;
export const PROJECT_ROLE_OPTIONS: readonly ProjectRole[] = ["planner", "implementer", "reviewer", "tester", "fixer"];

export interface ProjectMember {
  agentId: string;
  role: ProjectRole;
  responsibilities: string;
  instructions?: string;
  enabled: boolean;
  /** Holds the Project Manager responsibility; at most one member does. */
  projectManager?: boolean;
}

export type ProjectSetupState = "drafting" | "proposed" | "failed" | "applied" | "dismissed";

/** Why a proposed member cannot be applied as is (projects/setup.py). */
export type ProjectSetupMemberIssue = "agent_not_found" | "agent_wrong_owner" | "agent_disabled" | "agent_off_computer";

export interface ProjectSetupProposal {
  name?: string;
  goal?: string;
  description?: string;
  context?: string;
  rationale?: string;
  leadAgentId?: string;
  members?: Array<{
    agentId: string;
    role: ProjectRole;
    responsibilities: string;
    instructions?: string;
    issue?: ProjectSetupMemberIssue;
    projectManager?: boolean;
  }>;
  tasks?: ProjectSetupProposedTask[];
}

/** A proposed task. `after` names earlier proposed tasks by key and
 *  `afterTaskIds` existing project tasks; applied, they become prerequisites. */
export interface ProjectSetupProposedTask {
  key?: string;
  title: string;
  description?: string;
  assignedAgentId?: string;
  after?: string[];
  afterTaskIds?: string[];
}

/** `setup` drafts the crew and first tasks; `plan` only the next tasks. */
export type ProjectSetupMode = "setup" | "plan";

/** An agent-drafted setup: an agent proposes, the owner applies. */
export interface ProjectSetup {
  state: ProjectSetupState;
  /** Absent on setups drafted before plan rounds existed. */
  mode?: ProjectSetupMode;
  draftId?: string;
  /** Task that owns the current drafting round. */
  taskId?: string;
  /** Proposal task key → the task created from it, once applied. */
  appliedTasks?: Record<string, string>;
  intent: string;
  agentId: string;
  threadId: string | null;
  startedAt: string;
  finishedAt?: string;
  resolvedAt?: string;
  error?: string;
  proposal?: ProjectSetupProposal;
}

export interface ProjectSetupCandidate {
  agentId: string;
  name: string;
  executorKind?: string;
  defaultRole?: AgentRole;
}

export interface ProjectSetupResponse {
  setup: ProjectSetup | null;
  candidates: ProjectSetupCandidate[];
}

export interface StartProjectSetupInput {
  intent: string;
  agentId?: string;
  /** Draft again in the same thread from the last proposal. */
  revise?: boolean;
  mode?: ProjectSetupMode;
}

export interface ApplySetupTasksInput {
  draftId: string;
  /** The proposal tasks to create; all of them when omitted. */
  taskKeys?: string[];
  /** Per task key: the agent to assign, or null to file it unassigned. */
  assignedAgentIds?: Record<string, string | null>;
}

export interface ProjectContextSuggestion {
  id: string;
  text: string;
  evidence?: string;
  threadId: string;
  runId: string;
  agentId?: string;
  createdAt: string;
}

export interface ProjectRecord {
  /** Derived from the roster: the member carrying `projectManager`. */
  managerAgentId?: string | null;
  managerThreadId?: string | null;
  id: string;
  ownerUserId: string;
  name: string;
  /** What the project is for. Absent on projects created before it existed. */
  description?: string;
  /** The one-line outcome every run in the project is told. */
  goal?: string;
  /** Standing conventions and constraints every run in the project reads. */
  context?: string;
  /** Bumped whenever `context` changes; runs pin the revision they read. */
  contextRevision?: number;
  /** The latest agent-drafted setup, absent when none was ever asked for. */
  setup?: ProjectSetup;
  /** Context lines project runs proposed, waiting for the owner to adopt or dismiss. */
  contextSuggestions?: ProjectContextSuggestion[];
  computerId: string;
  workspaceLayout: "project";
  workspaceSubpath: string;
  /** The existing directory on the computer the project links, when it links one. */
  workspaceHostPath?: string;
  leadAgentId: string | null;
  members: ProjectMember[];
  enabled: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
}

export interface ProjectsResponse {
  projects: ProjectRecord[];
}

export interface CreateProjectInput {
  /** Omitted: the lead holds the role. Null: nobody does yet. */
  managerAgentId?: string | null;
  name: string;
  description?: string;
  goal?: string;
  context?: string;
  daemonNodeId: string;
  /** An existing absolute directory on that computer; omitted creates a new one. */
  workspaceHostPath?: string;
  leadAgentId?: string | null;
  members: Array<{
    agentId: string;
    role: ProjectRole;
    responsibilities: string;
    instructions?: string;
    enabled?: boolean;
    projectManager?: boolean;
  }>;
}

export interface UpdateProjectInput {
  expectedVersion: number;
  name?: string;
  description?: string;
  goal?: string;
  context?: string;
  leadAgentId?: string | null;
  members?: CreateProjectInput["members"];
  enabled?: boolean;
  /** Closes the project's drafted setup in the same revision. */
  setupResolution?: "applied" | "dismissed";
  /** Suggestions this save adopted or dismissed; both leave the pending list. */
  resolveContextSuggestions?: string[];
}
