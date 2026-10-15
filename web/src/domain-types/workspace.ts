import type {
  AgentName,
  DaemonNodeMonitorRecord,
  RelaySession,
  RoutinePauseReason,
  RoutineState,
  RoutineTrigger,
  TaskPriority,
  TaskStatus,
} from "relay-core";
import type { ArtifactIndexItem } from "./artifacts.ts";

export interface WorkspaceBriefSession {
  id: string;
  projectId?: string;
  title?: string;
  taskGoal?: string;
  status?: RelaySession["status"];
  phase?: string;
  daemonNodeId?: string;
  managedNodeId?: string;
  workspacePath?: string;
  ownerUserId?: string;
  ownerAgentId?: string;
  teamId?: string;
  currentAgent?: AgentName;
  pendingDecision?: RelaySession["pendingDecision"];
  artifactCount: number;
  runCount: number;
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceBriefTask {
  id: string;
  projectId?: string;
  title?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  ownerUserId?: string;
  assigneeUserId?: string;
  assignedAgent?: AgentName;
  assignedAgentId?: string;
  assignedTeamId?: string;
  dueDate?: string;
  isRoutine: boolean;
  routineTriggers?: RoutineTrigger[];
  routineState?: RoutineState;
  routinePauseReason?: RoutinePauseReason;
  routineNextRunAt?: string;
  linkedSessionIds: string[];
  updatedAt?: string;
  createdAt?: string;
}

export interface WorkspaceBriefResponse {
  userId: string;
  teamId?: string;
  projectId?: string;
  workspacePath?: string;
  nodes: DaemonNodeMonitorRecord[];
  activeRuns: DaemonNodeMonitorRecord["activeRuns"];
  sessions: WorkspaceBriefSession[];
  tasks: WorkspaceBriefTask[];
  artifacts: ArtifactIndexItem[];
  metrics: {
    nodeCount: number;
    activeRunCount: number;
    sessionCount: number;
    activeSessionCount: number;
    taskCount: number;
    activeTaskCount: number;
    artifactCount: number;
  };
  generatedAt: string;
}

export type WorkspaceFileKind = "directory" | "file";

export interface WorkspaceFileEntry {
  name: string;
  path: string;
  kind: WorkspaceFileKind;
  bytes?: number | null;
  updatedAt: string;
}


export interface ProjectWorkspaceFilesResponse {
  projectId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  generatedAt: string;
}

export interface ProjectWorkspaceFileResponse {
  projectId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  isBinary: boolean;
  bytes: number;
  content: string | null;
  contentBase64?: string | null;
  truncated: boolean;
  limitBytes: number;
  generatedAt: string;
}

export interface TaskWorkspaceFilesResponse {
  workspaceLayout?: "thread" | "task" | "project" | "node-root";
  sharedWithProject?: boolean;
  taskId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  entries: WorkspaceFileEntry[];
  generatedAt: string;
}

export interface TaskWorkspaceFileResponse {
  taskId: string;
  scope: "shared";
  source: "live";
  nodeId: string;
  path: string;
  exists: boolean;
  isBinary: boolean;
  bytes: number;
  content: string | null;
  contentBase64?: string | null;
  truncated: boolean;
  limitBytes: number;
  generatedAt: string;
}
