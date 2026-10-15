import type {
  AgentName,
  ComputerTokenResponse,
  CreateLocalDeviceEnrollmentInput,
  CreateLocalDeviceEnrollmentResponse,
  DaemonNodeMonitorRecord,
  DaemonNodesResponse,
  SandboxesResponse,
  SandboxRecord,
} from "../types.ts";
import { apiJson } from "./client.ts";

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

export function provisionSandbox(userId: string, token?: string, nodeToken?: string): Promise<SandboxRecord> {
  // No workspacePath: the daemon matches by user, so we attach to the
  // user's registered daemon node (whatever workspace it runs in) instead
  // of provisioning a dead placeholder under a fabricated path.
  return apiJson<SandboxRecord>("/sandboxes", {
    method: "POST",
    token,
    body: {
      userId,
      ...(nodeToken ? { nodeToken } : {}),
    },
  });
}

export function requestRuntimeRefresh(nodeId: string): Promise<{ commandId: string }> {
  return apiJson(`/daemon-nodes/${encodeURIComponent(nodeId)}/runtime-refresh`, { method: "POST" });
}

export function getRuntimeRefresh(nodeId: string, commandId: string): Promise<{ status: string }> {
  return apiJson(`/daemon-nodes/${encodeURIComponent(nodeId)}/runtime-refresh/${encodeURIComponent(commandId)}`);
}

export interface ComputerAuthorizationDetails { displayName: string; workspacePath: string; status: string }
export function getComputerSetupCommand(): Promise<{ installCommand: string; windowsInstallCommand?: string }> {
  return apiJson("/computer-authorizations/setup-command");
}
export function getComputerAuthorization(code: string): Promise<ComputerAuthorizationDetails> {
  return apiJson(`/computer-authorizations/${encodeURIComponent(code)}`);
}
export function approveComputerAuthorization(code: string): Promise<{ status: string }> {
  return apiJson(`/computer-authorizations/${encodeURIComponent(code)}/approve`, { method: "POST" });
}
