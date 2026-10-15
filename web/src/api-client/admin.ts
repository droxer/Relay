import type {
  AgentName,
  AssignControlPanelDaemonNodeResponse,
  ControlPanelDaemonNodesResponse,
  ControlPanelUsersResponse,
  CreateControlPanelDaemonNodeInput,
  CreateControlPanelDaemonNodeResponse,
  CreateControlPanelUserInput,
  CreateControlPanelUserResponse,
  CreateManagedNodeInput,
  CreateManagedNodeResponse,
  ManagedNodeRecord,
  ManagedNodesResponse,
  OrgSettingsResponse,
  UnassignControlPanelDaemonNodeResponse,
  UpdateControlPanelUserInput,
  UserRecord,
} from "../types.ts";
import { apiJson } from "./client.ts";

export function listControlPanelDaemonNodes(signal?: AbortSignal): Promise<ControlPanelDaemonNodesResponse> {
  return apiJson<ControlPanelDaemonNodesResponse>("/admin/daemon-nodes", { signal });
}

export function listControlPanelUsers(signal?: AbortSignal): Promise<ControlPanelUsersResponse> {
  return apiJson<ControlPanelUsersResponse>("/admin/users", { signal });
}

export function createControlPanelUser(
  input: CreateControlPanelUserInput,
): Promise<CreateControlPanelUserResponse> {
  return apiJson<CreateControlPanelUserResponse>("/admin/users", {
    method: "POST",
    body: {
      userId: input.userId,
      username: input.username,
      password: input.password,
      ...(input.nodeId ? { nodeId: input.nodeId } : {}),
      ...(input.email ? { email: input.email } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.maxLocalComputers != null ? { maxLocalComputers: input.maxLocalComputers } : {}),
    },
  });
}

/** Patch a user's profile. Only the keys present in `input` are sent, so
    an omitted field is left alone; `maxLocalComputers: null` clears the
    override rather than meaning "no computers". */
export function updateControlPanelUser(
  input: UpdateControlPanelUserInput,
): Promise<{ user: UserRecord }> {
  return apiJson<{ user: UserRecord }>(
    `/admin/users/${encodeURIComponent(input.userId)}`,
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
  patch: { maxLocalComputersPerUser?: number; maxTaskRounds?: number },
): Promise<OrgSettingsResponse> {
  return apiJson<OrgSettingsResponse>("/admin/settings", {
    method: "PUT",
    body: patch,
  });
}

export function assignControlPanelDaemonNode(
  input: { nodeId: string; userId: string },
): Promise<AssignControlPanelDaemonNodeResponse> {
  return apiJson<AssignControlPanelDaemonNodeResponse>(`/admin/daemon-nodes/${encodeURIComponent(input.nodeId)}/assignment`, {
    method: "PUT",
    body: { userId: input.userId },
  });
}

export function createControlPanelDaemonNode(
  input: CreateControlPanelDaemonNodeInput,
): Promise<CreateControlPanelDaemonNodeResponse> {
  return apiJson<CreateControlPanelDaemonNodeResponse>("/admin/daemon-nodes", {
    method: "POST",
    body: {
      ...(input.userId ? { userId: input.userId } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
      ...(input.sandboxMode ? { sandboxMode: input.sandboxMode } : {}),
      ...(input.nodeLocation ? { nodeLocation: input.nodeLocation } : {}),
    },
  });
}

export function createManagedNode(input: CreateManagedNodeInput): Promise<CreateManagedNodeResponse> {
  return apiJson<CreateManagedNodeResponse>("/admin/managed-nodes", {
    method: "POST",
    body: {
      userId: input.userId,
      ...(input.displayName ? { displayName: input.displayName } : {}),
      assignmentMode: "dedicated",
      provider: "local-process",
      profile: "standard",
      sandboxMode: input.sandboxMode,
      workspacePolicy: { kind: "user-home" },
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

export function deleteControlPanelUser(
  userId: string,
): Promise<{ user: { id: string; deletedAt: string }; unassignedNodes: string[] }> {
  return apiJson<{ user: { id: string; deletedAt: string }; unassignedNodes: string[] }>(
    `/admin/users/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export interface DashboardSessionsResponse {
  total: number;
  last24h: number;
  last7d: number;
  statusCounts: Record<string, number>;
  dailyCounts: Array<{ date: string; count: number; completed: number; failed: number }>;
  topUsers: Array<{ userId: string; sessionCount: number }>;
}

export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** cacheRead + cacheWrite. */
  cache: number;
  /** Every token processed, cache reads included. */
  total: number;
  /** The headline: input + output + cacheWrite. */
  fresh: number;
}

export interface TokenUsageSnapshot {
  available: boolean;
  /** The IANA zone the server bucketed days in (falls back to UTC). */
  timeZone: string;
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalCache: number;
  total: number;
  fresh: number;
  daily: Array<TokenCounts & { date: string }>;
  /** Runs that completed in the summary window without reporting counts, per runtime. */
  unreportedRuns: Array<{ agent: string; runs: number }>;
}

export function getDashboardSessions(signal?: AbortSignal): Promise<DashboardSessionsResponse> {
  return apiJson<DashboardSessionsResponse>("/admin/dashboard/sessions", { signal });
}

export function getDashboardTokens(signal?: AbortSignal, timeZone = viewerTimeZone()): Promise<TokenUsageSnapshot> {
  // Days are bucketed in the viewer's zone so a late-evening run lands on the
  // day the chart labels it with.
  const query = timeZone ? `?tz=${encodeURIComponent(timeZone)}` : "";
  return apiJson<TokenUsageSnapshot>(`/admin/dashboard/tokens${query}`, { signal });
}

function viewerTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}
