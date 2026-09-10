import type { ChildProcess } from "node:child_process";
import type { ControlPanelDaemonNodeRecord } from "relay-core";

export interface EmployeeRecord {
  id: string;
  displayName?: string;
  email?: string;
  departmentId?: string;
  departmentName?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface SupervisorBackend {
  listEmployees(): Promise<EmployeeRecord[]>;
  listDaemonNodes(): Promise<ControlPanelDaemonNodeRecord[]>;
  provisionDaemonNode(input: { employeeId: string; workspacePath?: string }): Promise<ProvisionedDaemonNode>;
}

export type ManagedNodeDesiredState = "running" | "stopped" | "deleted";
export type ManagedNodePhase = "requested" | "allocating" | "bootstrapping" | "registering" | "recovering" | "ready" | "draining" | "stopped" | "deleting" | "deleted" | "failed";

export interface ManagedNodeRecord {
  id: string;
  displayName: string;
  employeeId?: string;
  assignmentMode: "dedicated" | "pooled" | "shared";
  provider: string;
  profile: string;
  sandboxMode: "boxlite";
  workspacePolicy: Record<string, unknown>;
  desiredState: ManagedNodeDesiredState;
  generation: number;
  phase: ManagedNodePhase;
  activeAttemptId?: string;
  activeDaemonNodeId?: string;
  conditions: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface ProvisioningAttemptRecord {
  id: string;
  managedNodeId: string;
  generation: number;
  attemptNumber: number;
  status: string;
  providerInstanceId?: string;
  providerOperationId?: string;
  errorCode?: string;
  errorMessage?: string;
  retryAt?: string;
  startedAt: string;
  updatedAt: string;
}

export interface ManagedNodeBackend {
  listManagedNodes(): Promise<ManagedNodeRecord[]>;
  listDaemonNodes(): Promise<ControlPanelDaemonNodeRecord[]>;
  listProvisioningAttempts(nodeId: string): Promise<ProvisioningAttemptRecord[]>;
  createProvisioningAttempt(nodeId: string): Promise<{ attempt: ProvisioningAttemptRecord; enrollmentCredential: string }>;
  updateProvisioningAttempt(nodeId: string, attemptId: string, patch: Record<string, unknown>): Promise<ProvisioningAttemptRecord>;
  updateManagedNode(nodeId: string, patch: Record<string, unknown>): Promise<ManagedNodeRecord>;
  retireManagedNodeRuntime(nodeId: string): Promise<void>;
}

export interface EnsureManagedNodeInput {
  node: ManagedNodeRecord;
  attempt: ProvisioningAttemptRecord;
  backendUrl: string;
  enrollmentCredential: string;
  workspacePath: string;
  workspaceId: string;
}

export interface ProviderInstance {
  id: string;
  child?: ChildProcess;
}

export interface ManagedNodeProvider {
  readonly name: string;
  ensure(input: EnsureManagedNodeInput): Promise<ProviderInstance>;
  inspect(instanceId: string): Promise<"running" | "stopped" | "unknown">;
  stop(instanceId: string): Promise<void>;
  delete(instanceId: string): Promise<void>;
}

export interface ProvisionedDaemonNode {
  node: ControlPanelDaemonNodeRecord;
  nodeToken?: string;
  daemonEnv: Record<string, string>;
}

export interface DaemonLaunchRequest {
  employee: EmployeeRecord;
  node: ControlPanelDaemonNodeRecord;
  env: Record<string, string>;
  workspacePath: string;
}

export interface ManagedDaemon {
  readonly key: string;
  readonly provider: string;
  readonly child?: ChildProcess;
  stop(): Promise<void>;
}

export interface DaemonLauncher {
  /** Remote readiness is observed through backend HTTP heartbeats. */
  readonly connectionMode?: "http";
  readonly name: string;
  start(request: DaemonLaunchRequest): Promise<ManagedDaemon>;
}

export interface SupervisorLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}
