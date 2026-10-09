import type { AgentName } from "./state.js";
import type {
  DaemonAgentAdapter,
  DaemonAgentInventory,
  DaemonNodeCapability,
  DaemonNodeSandboxMode,
} from "./daemon-node-protocol.js";
import type { AgentRole } from "./session-store.js";

export type SandboxStatus = "provisioning" | "ready" | "busy" | "running" | "stopped" | "failed";
export type DaemonNodeLocation = "employee-device" | "managed";

export interface SandboxRecord {
  id: string;
  displayName?: string;
  employeeId?: string;
  workspacePath?: string;
  /** Stable host machine identity reported by the daemon; not a workspace path. */
  workspaceId?: string;
  sandboxMode?: DaemonNodeSandboxMode;
  capabilities?: DaemonNodeCapability[];
  nodeLocation?: DaemonNodeLocation;
  managedNodeId?: string;
  provisioningAttemptId?: string;
  credentialVersion?: number;
  retiredAt?: string;
  status: SandboxStatus;
  agents: Record<AgentName, "unknown" | "ready" | "failed">;
  agentDetails?: Partial<Record<AgentName, {
    detail?: string;
    version?: string;
    adapter?: DaemonAgentAdapter;
  }>>;
  disabledAgents?: AgentName[];
  agentInventory?: Partial<Record<AgentName, DaemonAgentInventory>>;
  /** Runtimes whose model calls go to a custom endpoint, not the vendor API. */
  customModelEndpoints?: AgentName[];
  agentRoleDefaults?: Partial<Record<AgentName, AgentRole>>;
  agentRoleOverrides?: Partial<Record<AgentName, AgentRole>>;
  maxConcurrentRuns?: number;
  token?: string;
  tokenHash?: string;
  uiTokenHash?: string;
  nodeTokenHash?: string;
  nodeToken?: string;
  createdAt: string;
  updatedAt: string;
  lastSeenAt?: string;
  lastError?: string;
}

export interface SandboxRunAssignment {
  agentId?: string;
  agent: AgentName;
  role?: AgentRole;
}

export interface DaemonNodeActiveRun {
  commandId: string;
  sessionId: string;
  runId: string;
  agent: AgentName;
  logicalAgentId?: string;
  placementId?: string;
  taskGoal: string;
  workspacePath?: string;
  startedAt: string;
}

export interface DaemonNodeMonitorRecord extends Omit<SandboxRecord, "token" | "tokenHash" | "uiTokenHash" | "nodeTokenHash" | "nodeToken"> {
  queuedCommandCount: number;
  activeRuns: DaemonNodeActiveRun[];
  online: boolean;
  stale: boolean;
  lastSeenAgeMs?: number;
}

export interface ControlPanelDaemonNodeRecord extends DaemonNodeMonitorRecord {
  provisioningPlaceholder?: boolean;
  nodeToken?: string;
}
