import type { AgentName, AgentRole, CollaborationStyle, RelaySession } from "relay-core";

export interface SessionSummary {
  workOutcome?: RelaySession["workOutcome"] | null;
  execution?: RelaySession["execution"];
  deletionRequestedAt?: string;
  id: string;
  title?: string;
  taskGoal: string;
  status: RelaySession["status"];
  phase: string;
  daemonNodeId?: string;
  managedNodeId?: string;
  workspacePath: string;
  ownerUserId?: string;
  ownerAgentId?: string;
  teamId?: string;
  projectId?: string;
  workspaceLayout?: "node-root" | "thread" | "project" | "task";
  workspaceSubpath?: string;
  computerId?: string;
  currentAgent?: AgentName;
  pendingDecision?: RelaySession["pendingDecision"];
  archived?: boolean;
  artifactCount: number;
  runCount: number;
  eventCount: number;
  updatedAt: string;
  createdAt: string;
}

export interface SessionSummariesResponse {
  sessions: SessionSummary[];
}

export interface AgentRunInput {
  style?: CollaborationStyle;
  taskGoal: string;
  /** Computer selected as the immutable runtime for a new thread. */
  daemonNodeId?: string;
  /** Team a brand-new thread belongs to; the backend expands it to the
   *  roster (lead first) and stamps the session with the team id. */
  teamId?: string;
  /** Project a brand-new thread belongs to; the backend expands its roster. */
  projectId?: string;
  /** Absent means "this thread's participants" — the whole team for a team thread. */
  assignments?: Array<{
    agentId: string;
    role?: AgentRole;
    brief?: string;
  }>;
  sessionId?: string;
  userMessageId?: string;
  decision?: {
    kind: "rerun" | "handoff";
    targetAgent: AgentName;
    targetAgentId?: string;
    note?: string;
  };
}

export interface ThreadMessageInput {
  style?: CollaborationStyle;
  text: string;
  intent: "accomplish" | "discuss" | "review";
  /** Agents this message addresses. Empty or absent means the whole room. */
  addressAgentIds?: string[];
  /** A team on the thread's computer that runs this round instead. Exclusive
   *  with `addressAgentIds`; the thread keeps its own team, if it has one. */
  addressTeamId?: string;
  userMessageId?: string;
  idempotencyKey?: string;
}

export interface ThreadRecoveryInput {
  kind: "rerun" | "handoff";
  targetAgentId: string;
  note?: string;
  idempotencyKey?: string;
  /** A rerun that continues the agent's own runtime conversation. */
  resume?: boolean;
}

export interface RunInput {
  sandboxId: string;
  taskGoal: string;
  assignments: Array<{
    agentId?: string;
    agent: AgentName;
    role?: AgentRole;
    brief?: string;
  }>;
  sessionId?: string;
  /** Client-generated id for the follow-up user message, so the optimistic echo
   * reconciles with the persisted event by id. Ignored for new sessions. */
  userMessageId?: string;
  decision?: {
    kind: "rerun" | "handoff";
    note?: string;
    targetAgent?: AgentName;
    targetAgentId?: string;
  };
}
