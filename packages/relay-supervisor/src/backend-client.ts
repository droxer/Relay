import { relayApiUrl, type ControlPanelDaemonNodeRecord } from "relay-core";
import type { EmployeeRecord, ManagedNodeBackend, ManagedNodeRecord, ProvisionedDaemonNode, ProvisioningAttemptRecord, SupervisorBackend } from "./types.js";

interface SupervisorBackendClientOptions {
  backendUrl: string;
  adminToken?: string;
  fetchFn?: typeof fetch;
  requestTimeoutMs?: number;
}

class SupervisorBackendRequestError extends Error {
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    readonly responseBody: string,
  ) {
    super(`${method} ${path} failed: ${status} ${responseBody}`);
    this.name = "SupervisorBackendRequestError";
  }
}

export class SupervisorBackendClient implements SupervisorBackend, ManagedNodeBackend {
  private readonly backendUrl: string;
  private readonly adminToken?: string;
  private readonly fetchFn: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: SupervisorBackendClientOptions) {
    this.backendUrl = options.backendUrl.replace(/\/+$/, "");
    this.adminToken = options.adminToken;
    this.fetchFn = options.fetchFn ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  async listEmployees(): Promise<EmployeeRecord[]> {
    return (await this.request<{ employees: EmployeeRecord[] }>("/admin/employees")).employees;
  }

  async listDaemonNodes(): Promise<ControlPanelDaemonNodeRecord[]> {
    return (await this.request<{ nodes: ControlPanelDaemonNodeRecord[] }>("/admin/daemon-nodes")).nodes
      .filter((node) => !node.provisioningPlaceholder);
  }

  async provisionDaemonNode(input: { employeeId: string; workspacePath?: string }): Promise<ProvisionedDaemonNode> {
    return await this.request<ProvisionedDaemonNode>("/admin/daemon-nodes", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async listManagedNodes(): Promise<ManagedNodeRecord[]> {
    return (await this.request<{ nodes: ManagedNodeRecord[] }>("/admin/managed-nodes")).nodes;
  }

  async createProvisioningAttempt(nodeId: string): Promise<{ attempt: ProvisioningAttemptRecord; enrollmentCredential: string }> {
    return await this.request(`/admin/managed-nodes/${encodeURIComponent(nodeId)}/attempts`, { method: "POST" });
  }

  async listProvisioningAttempts(nodeId: string): Promise<ProvisioningAttemptRecord[]> {
    return (await this.request<{ attempts: ProvisioningAttemptRecord[] }>(
      `/admin/managed-nodes/${encodeURIComponent(nodeId)}/attempts`,
    )).attempts;
  }

  async updateManagedNode(nodeId: string, patch: Record<string, unknown>): Promise<ManagedNodeRecord> {
    return (await this.request<{ node: ManagedNodeRecord }>(`/admin/managed-nodes/${encodeURIComponent(nodeId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    })).node;
  }

  async retireManagedNodeRuntime(nodeId: string): Promise<void> {
    await this.request(`/admin/managed-nodes/${encodeURIComponent(nodeId)}/runtime`, {
      method: "DELETE",
    });
  }

  async updateProvisioningAttempt(nodeId: string, attemptId: string, patch: Record<string, unknown>): Promise<ProvisioningAttemptRecord> {
    return (await this.request<{ attempt: ProvisioningAttemptRecord }>(
      `/admin/managed-nodes/${encodeURIComponent(nodeId)}/attempts/${encodeURIComponent(attemptId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    )).attempt;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.adminToken) headers.set("authorization", `Bearer ${this.adminToken}`);
    const timeoutSignal = AbortSignal.timeout(this.requestTimeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.fetchFn(relayApiUrl(this.backendUrl, path), {
      ...init,
      headers,
      signal,
    });
    if (!response.ok) {
      throw new SupervisorBackendRequestError(
        init.method ?? "GET",
        path,
        response.status,
        await response.text(),
      );
    }
    if (response.status === 204) return undefined as T;
    return await response.json() as T;
  }
}
