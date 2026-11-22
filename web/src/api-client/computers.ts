import type {
  AgentName,
  ComputerTokenResponse,
  CreateLocalDeviceEnrollmentInput,
  CreateLocalDeviceEnrollmentResponse,
  DaemonNodeMonitorRecord,
  DaemonNodesResponse,
  SandboxesResponse,
} from "../types.ts";
import type { ReportCleanupResult, ReportCleanupScope } from "relay-core";
import { apiJson } from "./client.ts";

export function listSandboxes(token?: string, signal?: AbortSignal): Promise<SandboxesResponse> {
  return apiJson<SandboxesResponse>("/sandboxes", { token, signal });
}

export function listDaemonNodes(token?: string, signal?: AbortSignal): Promise<DaemonNodesResponse> {
  return apiJson<DaemonNodesResponse>("/daemon-nodes?view=web", { token, signal });
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

export function requestRuntimeRefresh(nodeId: string): Promise<{ commandId: string }> {
  return apiJson(`/daemon-nodes/${encodeURIComponent(nodeId)}/runtime-refresh`, { method: "POST" });
}

export function getRuntimeRefresh(nodeId: string, commandId: string): Promise<{ status: string }> {
  return apiJson(`/daemon-nodes/${encodeURIComponent(nodeId)}/runtime-refresh/${encodeURIComponent(commandId)}`);
}

type ReportCleanupInput = { action: "preview" } | {
  action: "discard";
  scope: ReportCleanupScope;
  revision: string;
  acknowledgeOutputLoss: true;
};

export async function requestReportCleanup(nodeId: string, body: ReportCleanupInput, callerSignal: AbortSignal): Promise<ReportCleanupResult> {
  const signal = AbortSignal.any([callerSignal, AbortSignal.timeout(40_000)]);
  const path = `/daemon-nodes/${encodeURIComponent(nodeId)}/report-cleanup`;
  const { commandId } = await apiJson<{ commandId: string }>(path, { method: "POST", body, signal });
  while (!signal.aborted) {
    const { status, result } = await apiJson<{ status: string; result?: ReportCleanupResult }>(
      `${path}/${encodeURIComponent(commandId)}`, { signal },
    );
    if (status === "completed" && result) return result;
    if (status !== "queued" && status !== "dispatched") break;
    await new Promise<void>(resolve => setTimeout(resolve, 750));
  }
  throw new Error("The Computer did not confirm the report cleanup request.");
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
