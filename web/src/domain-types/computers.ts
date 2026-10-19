import type { ControlPanelDaemonNodeRecord, DaemonNodeMonitorRecord, SandboxRecord } from "relay-core";

/* The node records the web reads carry one field the shared protocol type
   does not: whether the computer runs an older Relay client than the server
   expects. The backend derives it per read; only the web renders it, so it
   is declared here rather than in relay-core. Absent on an older backend. */
declare module "relay-core" {
  interface DaemonNodeMonitorRecord {
    clientOutdated?: boolean;
  }
}
import type { UserRecord } from "./users.ts";

export interface SandboxesResponse {
  sandboxes: SandboxRecord[];
}

export interface DaemonNodesResponse {
  nodes: DaemonNodeMonitorRecord[];
}

export interface ControlPanelDaemonNodesResponse {
  nodes: ControlPanelDaemonNodeRecord[];
}

export interface AssignControlPanelDaemonNodeResponse {
  user: UserRecord;
  node: ControlPanelDaemonNodeRecord;
}

export interface UnassignControlPanelDaemonNodeResponse {
  node: ControlPanelDaemonNodeRecord;
}

interface CreateControlPanelDaemonNodeCommon {
  userId?: string;
  displayName?: string;
}

/** `nodeLocation` and `sandboxMode` are not independent, so they are paired in
    the type rather than left to each call site: a user device runs agents
    as host processes against the installs already on it, and BoxLite isolation
    belongs to hardware an admin provisions. Both admin drawers had drifted to
    sending the isolated runtime for a local computer, which the backend now
    also refuses — this makes it a compile error instead of a start command the
    user's laptop cannot execute. */
export type CreateControlPanelDaemonNodeInput =
  | (CreateControlPanelDaemonNodeCommon & {
      nodeLocation: "user-device";
      /** Where the agents' work lands on that device; required, and absolute. */
      workspacePath: string;
      sandboxMode: "none";
    })
  | (CreateControlPanelDaemonNodeCommon & {
      nodeLocation?: never;
      workspacePath?: string;
      /** Runtime isolation only; management ownership is represented by managedNodeId. */
      sandboxMode?: "boxlite";
    });

export interface CreateControlPanelDaemonNodeResponse {
  node: ControlPanelDaemonNodeRecord;
  sandboxToken?: string;
  nodeToken?: string;
  daemonCommand?: string;
  daemonEnv: Record<string, string>;
}

/** Self-service registration of the caller's own device — no userId, the backend
    attributes it to the authenticated actor, and no sandboxMode: a personal computer
    runs its agents directly. */
export interface CreateLocalDeviceEnrollmentInput {
  workspacePath: string;
  displayName?: string;
}

export interface CreateLocalDeviceEnrollmentResponse extends CreateControlPanelDaemonNodeResponse {
  /** Downloads the client and starts a per-user service; contains no credential. */
  installCommand?: string;
  /** The PowerShell equivalent of `installCommand` for a Windows computer. */
  windowsInstallCommand?: string;
  /** True when an existing computer was adopted instead of a new one created. */
  reused?: boolean;
}

/** Owner-scoped answer to a reveal or reissue: the plaintext launch token plus
    the env and command that start the daemon with it. */
export interface ComputerTokenResponse {
  /** Install or reconnect a personal computer without an existing daemon executable. */
  installCommand?: string;
  windowsInstallCommand?: string;
  nodeToken: string;
  daemonEnv: Record<string, string>;
  daemonCommand?: string;
}

export type ManagedNodePhase =
  | "requested"
  | "allocating"
  | "bootstrapping"
  | "registering"
  | "recovering"
  | "ready"
  | "draining"
  | "stopped"
  | "deleting"
  | "deleted"
  | "failed";

export interface ManagedNodeRecord {
  id: string;
  displayName: string;
  userId?: string;
  assignmentMode: "dedicated" | "pooled" | "shared";
  provider: string;
  profile: string;
  // "none" on a provider that gives each computer its own VM.
  sandboxMode: "boxlite" | "none";
  workspacePolicy: Record<string, unknown>;
  desiredState: "running" | "stopped" | "deleted";
  generation: number;
  phase: ManagedNodePhase;
  activeAttemptId?: string;
  activeDaemonNodeId?: string;
  conditions: Array<Record<string, unknown>>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateManagedNodeInput {
  userId: string;
  displayName?: string;
}

export interface CreateManagedNodeResponse {
  node: ManagedNodeRecord;
}

export interface ManagedNodesResponse {
  nodes: ManagedNodeRecord[];
}
