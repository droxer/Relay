import { relayApiEndpoint, relayBackendPath } from "./lib/apiOrigin.ts";
import type {
  AgentName,
  AgentRole,
  ArtifactsResponse,
  AssignControlPanelDaemonNodeResponse,
  ChatIntegration,
  ChatIntegrationsResponse,
  ChatProvider,
  ComputerTokenResponse,
  CreateAgentInput,
  CreateAgentResponse,
  CreateControlPanelEmployeeInput,
  CreateControlPanelEmployeeResponse,
  CreateControlPanelDaemonNodeInput,
  CreateControlPanelDaemonNodeResponse,
  CreateLocalDeviceEnrollmentInput,
  CreateLocalDeviceEnrollmentResponse,
  CreateManagedNodeInput,
  CreateManagedNodeResponse,
  ManagedNodesResponse,
  ManagedNodeRecord,
  CreateProjectInput,
  CreateTaskInput,
  ControlPanelDaemonNodesResponse,
  ControlPanelEmployeesResponse,
  CurrentUser,
  UnassignControlPanelDaemonNodeResponse,
  DaemonNodeMonitorRecord,
  DaemonNodesResponse,
  EmployeeAgentsResponse,
  EmployeeAgent,
  EmployeeRecord,
  OrgSettingsResponse,
  ProjectsResponse,
  ProjectRecord,
  UpdateProjectInput,
  UpdateControlPanelEmployeeInput,
  AgentTeam,
  AgentTeamsResponse,
  TeamMutationInput,
  AgentPlacement,
  AgentRunInput,
  RelaySession,
  RelayTask,
  RunInput,
  SandboxesResponse,
  SandboxRecord,

  SessionSummariesResponse,
  StartTaskResponse,

  TaskArtifactsResponse,
  TaskDeletionResponse,
  TaskEventsResponse,
  TaskRunsResponse,
  TaskMutationInput,
  TaskRunAssignment,
  ThreadMessageInput,
  ThreadRecoveryInput,
  TasksResponse,
  WorkspaceBriefResponse,


  ProjectWorkspaceFilesResponse,
  ProjectWorkspaceFileResponse,
  TaskWorkspaceFilesResponse,
  TaskWorkspaceFileResponse,
} from "./types.js";
import type { Language, Theme } from "./lib/appStorage.js";

export class RelayApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
  ) {
    super(message);
  }
}

function apiErrorMessage(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message;
  }
  return undefined;
}

function apiErrorCode(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && "code" in value && typeof value.code === "string") {
    return value.code;
  }
  return undefined;
}

export async function apiJson<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    credentials?: RequestCredentials;
    versioned?: boolean;
  } = {},
): Promise<T> {
  const response = await fetch(options.versioned === false ? relayBackendPath(path) : relayApiEndpoint(path), {
    method: options.method ?? "GET",
    signal: options.signal,
    credentials: options.credentials ?? "include",
    headers: {
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.trim() ? JSON.parse(text) : undefined;
  } catch (error) {
    if (!response.ok) {
      throw new RelayApiError(text.trim() || response.statusText, response.status);
    }
    if (response.headers.get("content-type")?.includes("text/html") || text.trimStart().startsWith("<")) {
      throw new RelayApiError(
        "Relay returned an HTML response where this API expected JSON. Restart the Relay backend and web server, then try again.",
        response.status,
      );
    }
    throw error;
  }
  if (!response.ok) {
    const detail = parsed && typeof parsed === "object" && "detail" in parsed ? parsed.detail : undefined;
    const error = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : undefined;
    const message = apiErrorMessage(detail)
      ?? apiErrorMessage(error)
      ?? (text.trim() || response.statusText);
    const code = apiErrorCode(detail) ?? apiErrorCode(error);
    throw new RelayApiError(message, response.status, code);
  }
  return parsed as T;
}

export function listSandboxes(token?: string, signal?: AbortSignal): Promise<SandboxesResponse> {
  return apiJson<SandboxesResponse>("/sandboxes", { token, signal });
}

export function listDaemonNodes(token?: string, signal?: AbortSignal): Promise<DaemonNodesResponse> {
  return apiJson<DaemonNodesResponse>("/daemon-nodes", { token, signal });
}

export function updateComputerDisplayName(
  nodeId: string,
  displayName: string | null,
): Promise<{ node: DaemonNodeMonitorRecord }> {
  return apiJson<{ node: DaemonNodeMonitorRecord }>(
    `/daemon-nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: { displayName } },
  );
}

export function updateDaemonNodeDisabledAgents(
  nodeId: string,
  disabledAgents: AgentName[],
): Promise<{ node: DaemonNodeMonitorRecord }> {
  return apiJson<{ node: DaemonNodeMonitorRecord }>(
    `/daemon-nodes/${encodeURIComponent(nodeId)}/disabled-agents`,
    { method: "PATCH", body: { disabledAgents } },
  );
}

export function listEmployeeAgents(signal?: AbortSignal): Promise<EmployeeAgentsResponse> {
  return apiJson<EmployeeAgentsResponse>("/agents", { signal });
}

export function createAgent(body: CreateAgentInput): Promise<CreateAgentResponse> {
  return apiJson<CreateAgentResponse>("/agents", { method: "POST", body });
}

export function listControlPanelAgents(employeeId?: string, signal?: AbortSignal): Promise<EmployeeAgentsResponse> {
  const query = employeeId ? `?employeeId=${encodeURIComponent(employeeId)}` : "";
  return apiJson<EmployeeAgentsResponse>(`/admin/agents${query}`, { signal });
}

export function listTeams(signal?: AbortSignal): Promise<AgentTeamsResponse> {
  return apiJson<AgentTeamsResponse>("/teams", { signal });
}

export function createTeam(input: TeamMutationInput): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>("/teams", { method: "POST", body: input });
}

export function updateTeam(teamId: string, input: Partial<TeamMutationInput>): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(`/teams/${encodeURIComponent(teamId)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteTeam(teamId: string): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(`/teams/${encodeURIComponent(teamId)}`, { method: "DELETE" });
}

export function getControlPanelAgent(agentId: string, signal?: AbortSignal): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, { signal });
}

export type EmployeeAgentMetaPatch = {
  displayName?: string;
  instructions?: string;
  /** null clears the role, so an agent can go back to no specialization. */
  defaultRole?: AgentRole | null;
};

export type EmployeeAgentAdminPatch = EmployeeAgentMetaPatch & {
  enabled?: boolean;
};

export function updateOwnEmployeeAgent(
  agentId: string,
  patch: EmployeeAgentMetaPatch,
): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(`/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function updateEmployeeAgent(
  agentId: string,
  patch: EmployeeAgentAdminPatch,
): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "PATCH",
    body: patch,
  });
}

export function deleteEmployeeAgent(agentId: string): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(`/admin/agents/${encodeURIComponent(agentId)}`, {
    method: "DELETE",
  });
}

export function updateAgentProfileImage(
  agentId: string,
  dataUrl: string,
): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(
    `/profile-images/agents/${encodeURIComponent(agentId)}`,
    { method: "PUT", body: { dataUrl }, versioned: false },
  );
}

export function deleteAgentProfileImage(
  agentId: string,
): Promise<{ agent: EmployeeAgent }> {
  return apiJson<{ agent: EmployeeAgent }>(
    `/profile-images/agents/${encodeURIComponent(agentId)}`,
    { method: "DELETE", versioned: false },
  );
}

export function updateTeamProfileImage(
  teamId: string,
  dataUrl: string,
): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(
    `/profile-images/teams/${encodeURIComponent(teamId)}`,
    { method: "PUT", body: { dataUrl }, versioned: false },
  );
}

export function deleteTeamProfileImage(
  teamId: string,
): Promise<{ team: AgentTeam }> {
  return apiJson<{ team: AgentTeam }>(
    `/profile-images/teams/${encodeURIComponent(teamId)}`,
    { method: "DELETE", versioned: false },
  );
}

export function deleteAgentPlacement(placementId: string): Promise<{ placement: AgentPlacement }> {
  return apiJson<{ placement: AgentPlacement }>(`/admin/agent-placements/${encodeURIComponent(placementId)}`, {
    method: "DELETE",
  });
}

export function listControlPanelDaemonNodes(signal?: AbortSignal): Promise<ControlPanelDaemonNodesResponse> {
  return apiJson<ControlPanelDaemonNodesResponse>("/admin/daemon-nodes", { signal });
}

export function listControlPanelEmployees(signal?: AbortSignal): Promise<ControlPanelEmployeesResponse> {
  return apiJson<ControlPanelEmployeesResponse>("/admin/employees", { signal });
}

export function createControlPanelEmployee(
  input: CreateControlPanelEmployeeInput,
): Promise<CreateControlPanelEmployeeResponse> {
  return apiJson<CreateControlPanelEmployeeResponse>("/admin/employees", {
    method: "POST",
    body: {
      employeeId: input.employeeId,
      username: input.username,
      password: input.password,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.maxLocalComputers != null ? { maxLocalComputers: input.maxLocalComputers } : {}),
    },
  });
}

/** Patch an employee's profile. Only the keys present in `input` are sent, so
    an omitted field is left alone; `maxLocalComputers: null` clears the
    override rather than meaning "no computers". */
export function updateControlPanelEmployee(
  input: UpdateControlPanelEmployeeInput,
): Promise<{ employee: EmployeeRecord }> {
  return apiJson<{ employee: EmployeeRecord }>(
    `/admin/employees/${encodeURIComponent(input.employeeId)}`,
    {
      method: "PATCH",
      body: {
        ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        ...(input.email !== undefined ? { email: input.email } : {}),
        ...(input.maxLocalComputers !== undefined
          ? { maxLocalComputers: input.maxLocalComputers }
          : {}),
      },
    },
  );
}

export function getOrgSettings(signal?: AbortSignal): Promise<OrgSettingsResponse> {
  return apiJson<OrgSettingsResponse>("/admin/settings", { signal });
}

/** Rotates the persisted admin token; the previous value stops working
    immediately. Refused (409) while the token is env-managed. */
export function reissueAdminToken(): Promise<{ adminToken: string }> {
  return apiJson<{ adminToken: string }>("/admin/admin-token/reissue", {
    method: "POST",
  });
}

/** Each field is optional: the backend leaves out what is not sent, so saving
    one card never overwrites the other with a stale value read earlier. */
export function updateOrgSettings(
  patch: { maxLocalComputersPerEmployee?: number; maxTaskRounds?: number },
): Promise<OrgSettingsResponse> {
  return apiJson<OrgSettingsResponse>("/admin/settings", {
    method: "PUT",
    body: patch,
  });
}

export function assignControlPanelDaemonNode(
  input: { nodeId: string; employeeId: string },
): Promise<AssignControlPanelDaemonNodeResponse> {
  return apiJson<AssignControlPanelDaemonNodeResponse>(`/admin/daemon-nodes/${encodeURIComponent(input.nodeId)}/assignment`, {
    method: "PUT",
    body: { employeeId: input.employeeId },
  });
}

export function createControlPanelDaemonNode(
  input: CreateControlPanelDaemonNodeInput,
): Promise<CreateControlPanelDaemonNodeResponse> {
  return apiJson<CreateControlPanelDaemonNodeResponse>("/admin/daemon-nodes", {
    method: "POST",
    body: {
      ...(input.employeeId ? { employeeId: input.employeeId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
      ...(input.nodeLocation ? { nodeLocation: input.nodeLocation } : {}),
    },
  });
}

/** Self-service: take the caller's own computer off the roster. */
export function disconnectComputer(nodeId: string): Promise<void> {
  return apiJson<void>(`/daemon-nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
}

/** Self-service: reveal the caller's own computer's launch token, for reconnecting. */
export function revealComputerToken(nodeId: string): Promise<ComputerTokenResponse> {
  return apiJson<ComputerTokenResponse>(`/daemon-nodes/${encodeURIComponent(nodeId)}/token`);
}

/** Self-service: rotate the caller's own computer's launch token. The old one
    stops working immediately; the daemon must be restarted with the new one. */
export function reissueComputerToken(nodeId: string): Promise<ComputerTokenResponse> {
  return apiJson<ComputerTokenResponse>(`/daemon-nodes/${encodeURIComponent(nodeId)}/token/reissue`, {
    method: "POST",
  });
}

/** Self-service: register the caller's own device as a computer, no admin involved. */
export function createLocalDeviceEnrollment(
  input: CreateLocalDeviceEnrollmentInput,
): Promise<CreateLocalDeviceEnrollmentResponse> {
  return apiJson<CreateLocalDeviceEnrollmentResponse>("/daemon-node-enrollments/local", {
    method: "POST",
    body: {
      workspacePath: input.workspacePath,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      sandboxMode: "none",
    },
  });
}

export function createManagedNode(input: CreateManagedNodeInput): Promise<CreateManagedNodeResponse> {
  return apiJson<CreateManagedNodeResponse>("/admin/managed-nodes", {
    method: "POST",
    body: {
      employeeId: input.employeeId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      assignmentMode: "dedicated",
      provider: "local-process",
      profile: "standard",
      sandboxMode: input.sandboxMode,
      workspacePolicy: { kind: "employee-home" },
      desiredState: "running",
    },
  });
}

export function updateManagedNodeDisplayName(
  nodeId: string,
  displayName: string | null,
): Promise<{ node: ManagedNodeRecord }> {
  return apiJson<{ node: ManagedNodeRecord }>(
    `/admin/managed-nodes/${encodeURIComponent(nodeId)}`,
    { method: "PATCH", body: { displayName } },
  );
}

export function deleteManagedNode(nodeId: string): Promise<CreateManagedNodeResponse | void> {
  return apiJson<CreateManagedNodeResponse | void>(`/admin/managed-nodes/${encodeURIComponent(nodeId)}`, {
    method: "DELETE",
  });
}

export function listManagedNodes(signal?: AbortSignal): Promise<ManagedNodesResponse> {
  return apiJson<ManagedNodesResponse>("/admin/managed-nodes", { signal });
}

export function recoverManagedNode(nodeId: string): Promise<{ node: ManagedNodeRecord }> {
  return apiJson<{ node: ManagedNodeRecord }>(
    `/admin/managed-nodes/${encodeURIComponent(nodeId)}/recover`,
    { method: "POST" },
  );
}

export function permanentlyDeleteManagedNode(nodeId: string): Promise<void> {
  return apiJson<void>(`/admin/managed-nodes/${encodeURIComponent(nodeId)}/record`, {
    method: "DELETE",
  });
}

export function unassignControlPanelDaemonNode(
  nodeId: string,
): Promise<UnassignControlPanelDaemonNodeResponse> {
  return apiJson<UnassignControlPanelDaemonNodeResponse>(
    `/admin/daemon-nodes/${encodeURIComponent(nodeId)}/assignment`,
    { method: "DELETE" },
  );
}

export function deleteControlPanelDaemonNode(nodeId: string): Promise<void> {
  return apiJson<void>(`/admin/daemon-nodes/${encodeURIComponent(nodeId)}`, { method: "DELETE" });
}

export function updateControlPanelDaemonNodeDisabledAgents(
  nodeId: string,
  disabledAgents: AgentName[],
): Promise<UnassignControlPanelDaemonNodeResponse> {
  return apiJson<UnassignControlPanelDaemonNodeResponse>(
    `/admin/daemon-nodes/${encodeURIComponent(nodeId)}/disabled-agents`,
    { method: "PATCH", body: { disabledAgents } },
  );
}

export function deleteControlPanelEmployee(
  employeeId: string,
): Promise<{ employee: { id: string; deletedAt: string }; unassignedNodes: string[] }> {
  return apiJson<{ employee: { id: string; deletedAt: string }; unassignedNodes: string[] }>(
    `/admin/employees/${encodeURIComponent(employeeId)}`,
    { method: "DELETE" },
  );
}

export function getAuthStatus(signal?: AbortSignal): Promise<{ requiresBootstrap: boolean }> {
  return apiJson<{ requiresBootstrap: boolean }>("/auth/status", { signal });
}

export function getMe(signal?: AbortSignal): Promise<{ authenticated: boolean; user?: CurrentUser }> {
  return apiJson<{ authenticated: boolean; user?: CurrentUser }>("/auth/me", { signal });
}

export function updateUserPreferences(input: { theme?: Theme; language?: Language }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/preferences", {
    method: "PATCH",
    body: input,
  });
}

export function bootstrapUser(input: { token: string; username: string; password: string }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/bootstrap", {
    method: "POST",
    body: input,
  });
}

export function login(input: { username: string; password: string }): Promise<{ user: CurrentUser }> {
  return apiJson<{ user: CurrentUser }>("/auth/login", {
    method: "POST",
    body: input,
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return apiJson<{ ok: boolean }>("/auth/logout", { method: "POST" });
}

export function listSessionSummaries(signal?: AbortSignal): Promise<SessionSummariesResponse> {
  return apiJson<SessionSummariesResponse>("/threads?view=summary", { signal });
}

export function getSession(sessionId: string, signal?: AbortSignal): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, { signal });
}

export function listArtifacts(
  input: { employeeId?: string; workspacePath?: string } = {},
  signal?: AbortSignal,
): Promise<ArtifactsResponse> {
  const params = new URLSearchParams();
  if (input.employeeId) params.set("employeeId", input.employeeId);
  if (input.workspacePath) params.set("workspacePath", input.workspacePath);
  const query = params.toString();
  return apiJson<ArtifactsResponse>(`/artifacts${query ? `?${query}` : ""}`, { signal });
}

export function getWorkspaceBrief(
  input: { employeeId?: string; agentId?: string; teamId?: string; projectId?: string } = {},
  signal?: AbortSignal,
): Promise<WorkspaceBriefResponse> {
  const params = new URLSearchParams();
  if (input.employeeId) params.set("employeeId", input.employeeId);
  if (input.agentId) params.set("agentId", input.agentId);
  if (input.teamId) params.set("teamId", input.teamId);
  if (input.projectId) params.set("projectId", input.projectId);
  const query = params.toString();
  return apiJson<WorkspaceBriefResponse>(`/workspace/brief${query ? `?${query}` : ""}`, { signal });
}


export function listProjectWorkspaceFiles(
  input: { projectId: string; path?: string },
  signal?: AbortSignal,
): Promise<ProjectWorkspaceFilesResponse> {
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  const query = params.toString();
  return apiJson<ProjectWorkspaceFilesResponse>(`/projects/${encodeURIComponent(input.projectId)}/workspace/files${query ? `?${query}` : ""}`, { signal });
}

export function readProjectWorkspaceFile(
  input: { projectId: string; path: string },
  signal?: AbortSignal,
): Promise<ProjectWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<ProjectWorkspaceFileResponse>(`/projects/${encodeURIComponent(input.projectId)}/workspace/file?${params.toString()}`, { signal });
}

export function listTaskWorkspaceFiles(
  input: { taskId: string; path?: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFilesResponse> {
  const params = new URLSearchParams();
  if (input.path) params.set("path", input.path);
  const query = params.toString();
  return apiJson<TaskWorkspaceFilesResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/files${query ? `?${query}` : ""}`, { signal });
}

export function readTaskWorkspaceFile(
  input: { taskId: string; path: string },
  signal?: AbortSignal,
): Promise<TaskWorkspaceFileResponse> {
  const params = new URLSearchParams({ path: input.path });
  return apiJson<TaskWorkspaceFileResponse>(`/tasks/${encodeURIComponent(input.taskId)}/workspace/file?${params.toString()}`, { signal });
}

export function listTasks(signal?: AbortSignal): Promise<TasksResponse> {
  return apiJson<TasksResponse>("/tasks?view=summary", { signal });
}

export function listProjects(signal?: AbortSignal): Promise<ProjectsResponse> {
  return apiJson<ProjectsResponse>("/projects", { signal });
}

export function createProject(input: CreateProjectInput): Promise<{ project: ProjectRecord }> {
  return apiJson<{ project: ProjectRecord }>("/projects", { method: "POST", body: input });
}

export function updateProject(projectId: string, input: UpdateProjectInput): Promise<{ project: ProjectRecord }> {
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: input,
  });
}

export function archiveProject(projectId: string, expectedVersion: number): Promise<{ project: ProjectRecord }> {
  const query = new URLSearchParams({ expectedVersion: String(expectedVersion) });
  return apiJson<{ project: ProjectRecord }>(`/projects/${encodeURIComponent(projectId)}?${query.toString()}`, {
    method: "DELETE",
  });
}

export function createTask(input: CreateTaskInput): Promise<RelayTask> {
  return apiJson<RelayTask>("/tasks", {
    method: "POST",
    body: input,
  });
}

export function updateTask(taskId: string, input: TaskMutationInput): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    body: input,
  });
}

export function deleteTask(taskId: string): Promise<TaskDeletionResponse> {
  return apiJson<TaskDeletionResponse>(`/tasks/${encodeURIComponent(taskId)}`, {
    method: "DELETE",
  });
}

export function assignTask(taskId: string, agentId: string): Promise<RelayTask> {
  return apiJson<RelayTask>(`/tasks/${encodeURIComponent(taskId)}/assignment`, {
    method: "PUT",
    body: { agentId },
  });
}

export function startTask(
  taskId: string,
  input: { assignments?: TaskRunAssignment[] } = {},
): Promise<StartTaskResponse> {
  return apiJson<StartTaskResponse>(`/tasks/${encodeURIComponent(taskId)}/runs`, {
    method: "POST",
    body: input,
  });
}

export function taskWorkspaceStatus(taskId: string, signal?: AbortSignal): Promise<{
  waiting: boolean; blockingSessionId?: string; blockingTitle?: string;
}> {
  return apiJson(`/tasks/${encodeURIComponent(taskId)}/workspace/status`, { signal });
}

export function listTaskArtifacts(taskId: string, signal?: AbortSignal, allVersions = false): Promise<TaskArtifactsResponse> {
  return apiJson<TaskArtifactsResponse>(`/tasks/${encodeURIComponent(taskId)}/artifacts${allVersions ? "?versions=all" : ""}`, { signal });
}

/**
 * The task's event log — the run history behind its current state.
 *
 * `includeOccurrences` folds in the logs of a routine's promoted occurrences,
 * which is where a routine's runs actually happen.
 */
export function listTaskEvents(
  taskId: string,
  options: { includeOccurrences?: boolean } = {},
  signal?: AbortSignal,
): Promise<TaskEventsResponse> {
  const query = options.includeOccurrences ? "?include=occurrences" : "";
  return apiJson<TaskEventsResponse>(`/tasks/${encodeURIComponent(taskId)}/events${query}`, { signal });
}

/**
 * The task's run ledger — one row per run, newest first.
 *
 * A routine's rows are its promoted occurrences; a plain task answers with a
 * single row for its own run.
 */
export function listTaskRuns(
  taskId: string,
  options: { limit?: number } = {},
  signal?: AbortSignal,
): Promise<TaskRunsResponse> {
  const query = options.limit ? `?limit=${encodeURIComponent(String(options.limit))}` : "";
  return apiJson<TaskRunsResponse>(`/tasks/${encodeURIComponent(taskId)}/runs${query}`, { signal });
}

export async function readArtifactText(
  sessionId: string,
  artifactId: string,
  signal?: AbortSignal,
): Promise<string> {
  const response = await fetch(
    relayApiEndpoint(`/threads/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}`),
    { credentials: "include", signal },
  );
  const text = await response.text();
  if (!response.ok) {
    throw new RelayApiError(text.trim() || response.statusText, response.status);
  }
  return text;
}

export interface DashboardSessionsResponse {
  total: number;
  last24h: number;
  last7d: number;
  statusCounts: Record<string, number>;
  dailyCounts: Array<{ date: string; count: number; completed: number; failed: number }>;
  topEmployees: Array<{ employeeId: string; sessionCount: number }>;
}

export interface TokenUsageSnapshot {
  available: boolean;
  totalInput: number;
  totalOutput: number;
  totalCache: number;
  total: number;
  unsupportedAgents: string[];
  daily: Array<{ date: string; input: number; output: number; cache: number; total: number }>;
  byEmployee: Array<{ employeeId: string; input: number; output: number; cache: number; total: number; sessionCount: number }>;
  recentSessions: Array<{ sessionId: string; employeeId?: string | null; taskGoal?: string; updatedAt?: string; input: number; output: number; cache: number; total: number }>;
}

export function getDashboardSessions(signal?: AbortSignal): Promise<DashboardSessionsResponse> {
  return apiJson<DashboardSessionsResponse>("/admin/dashboard/sessions", { signal });
}

export function getDashboardTokens(signal?: AbortSignal): Promise<TokenUsageSnapshot> {
  return apiJson<TokenUsageSnapshot>("/admin/dashboard/tokens", { signal });
}

export function listChatIntegrations(signal?: AbortSignal): Promise<ChatIntegrationsResponse> {
  return apiJson<ChatIntegrationsResponse>("/admin/chat-integrations", { signal });
}

export function createChatIntegration(input: {
  provider: ChatProvider;
  displayName: string;
  tenantId?: string;
  secrets?: Record<string, string>;
  config?: Record<string, string | number | boolean>;
}): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>("/admin/chat-integrations", {
    method: "POST",
    body: input,
  });
}

export function checkChatIntegration(integrationId: string): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/health-checks`,
    { method: "POST" },
  );
}

export function updateChatIntegration(
  integrationId: string,
  input: { displayName?: string; tenantId?: string; secrets?: Record<string, string>; config?: Record<string, string | number | boolean> },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}`,
    { method: "PATCH", body: input },
  );
}

export function activateChatIntegration(
  integrationId: string,
): Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }> {
  return apiJson<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/activations`,
    { method: "POST" },
  );
}

export function rotateTelegramWebhookSecret(
  integrationId: string,
): Promise<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }> {
  return apiJson<{ integration: ChatIntegration; provisioning: { ok: boolean; message: string } }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/webhook-secret-rotations`,
    { method: "POST" },
  );
}

export function addChatIdentityLink(
  integrationId: string,
  input: { externalUserId: string; employeeId: string; displayName?: string; defaultAgentId?: string },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/identity-links`,
    { method: "POST", body: input },
  );
}

export function deleteChatIdentityLink(integrationId: string, linkId: string): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/identity-links/${encodeURIComponent(linkId)}`,
    { method: "DELETE" },
  );
}

export function addChatAllowedConversation(
  integrationId: string,
  input: { conversationId: string; threadId?: string; label?: string },
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/allowed-conversations`,
    { method: "POST", body: input },
  );
}

export function deleteChatAllowedConversation(
  integrationId: string,
  conversationRecordId: string,
): Promise<{ integration: ChatIntegration }> {
  return apiJson<{ integration: ChatIntegration }>(
    `/admin/chat-integrations/${encodeURIComponent(integrationId)}/allowed-conversations/${encodeURIComponent(conversationRecordId)}`,
    { method: "DELETE" },
  );
}

export function provisionSandbox(employeeId: string, token?: string, nodeToken?: string): Promise<SandboxRecord> {
  // No workspacePath: the daemon matches by employee, so we attach to the
  // employee's registered daemon node (whatever workspace it runs in) instead
  // of provisioning a dead placeholder under a fabricated path.
  return apiJson<SandboxRecord>("/sandboxes", {
    method: "POST",
    token,
    body: {
      employeeId,
      ...(nodeToken ? { nodeToken } : {}),
    },
  });
}

export function runSandbox(input: RunInput, token?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/sandboxes/${encodeURIComponent(input.sandboxId)}/runs`, {
    method: "POST",
    token,
    body: {
      taskGoal: input.taskGoal,
      assignments: input.assignments,
      sessionId: input.sessionId,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    },
  });
}

export function runLogicalAgents(input: AgentRunInput): Promise<RelaySession> {
  return apiJson<RelaySession>("/agent-runs", {
    method: "POST",
    body: {
      taskGoal: input.taskGoal,
      ...(input.daemonNodeId ? { daemonNodeId: input.daemonNodeId } : {}),
      ...(input.teamId ? { teamId: input.teamId } : {}),
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.assignments ? { assignments: input.assignments } : {}),
      sessionId: input.sessionId,
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.decision ? { decision: input.decision } : {}),
    },
  });
}

export function submitThreadMessage(
  sessionId: string,
  input: ThreadMessageInput,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: {
      text: input.text,
      intent: input.intent,
      ...(input.addressAgentIds?.length
        ? { addressAgentIds: input.addressAgentIds }
        : {}),
      ...(input.userMessageId ? { userMessageId: input.userMessageId } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  });
}

export function requestThreadRecovery(
  sessionId: string,
  input: ThreadRecoveryInput,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/recoveries`, {
    method: "POST",
    body: {
      kind: input.kind,
      targetAgentId: input.targetAgentId,
      ...(input.note ? { note: input.note } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    },
  });
}

export function cancelRun(sessionId: string, token?: string, reason?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/cancellations`, {
    method: "POST",
    token,
    body: { reason: reason ?? "Cancelled from Relay Web UI." },
  });
}

export function recordDecision(
  sessionId: string,
  kind: "approve" | "reject" | "rerun" | "mark_done",
  note?: string,
  token?: string,
  targetAgent?: AgentName,
): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}/decisions`, {
    method: "POST",
    token,
    body: { kind, note, ...(targetAgent ? { targetAgent } : {}) },
  });
}

export function archiveSession(sessionId: string, token?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    token,
    body: { archived: true },
  });
}

export function deleteSession(sessionId: string, token?: string): Promise<void> {
  return apiJson<void>(`/threads/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
    token,
  });
}

export function renameSession(sessionId: string, title: string, token?: string): Promise<RelaySession> {
  return apiJson<RelaySession>(`/threads/${encodeURIComponent(sessionId)}`, {
    method: "PATCH",
    token,
    body: { title },
  });
}
