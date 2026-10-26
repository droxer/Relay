import type { AgentRole } from "relay-core";

export interface ProjectMember {
  agentId: string;
  role: AgentRole;
  responsibilities: string;
  instructions?: string;
  enabled: boolean;
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
    role: AgentRole;
    responsibilities: string;
    instructions?: string;
    issue?: ProjectSetupMemberIssue;
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
  /** Make the created tasks ready; each still waits for its prerequisites. */
  queue?: boolean;
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
    role: AgentRole;
    responsibilities: string;
    instructions?: string;
    enabled?: boolean;
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
