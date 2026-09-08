import type { ControlPanelDaemonNodeRecord } from "relay-core";
import type {
  DaemonLauncher,
  EmployeeRecord,
  ManagedDaemon,
  SupervisorBackend,
  SupervisorLogger,
} from "./types.js";

export interface SupervisorOptions {
  backend: SupervisorBackend;
  launcher: DaemonLauncher;
  workspacePathForEmployee: (employee: EmployeeRecord) => string;
  logger?: SupervisorLogger;
  registrationTimeoutMs?: number;
  now?: () => number;
}

export interface ReconcileResult {
  employees: number;
  provisioned: number;
  started: number;
  skipped: number;
}

export class RelaySupervisor {
  private readonly backend: SupervisorBackend;
  private readonly launcher: DaemonLauncher;
  private readonly workspacePathForEmployee: (employee: EmployeeRecord) => string;
  private readonly logger?: SupervisorLogger;
  private readonly now: () => number;
  private readonly registrationTimeoutMs: number;
  private readonly launchedAt = new Map<string, number>();
  private readonly managed = new Map<string, ManagedDaemon>();

  constructor(options: SupervisorOptions) {
    this.backend = options.backend;
    this.launcher = options.launcher;
    this.workspacePathForEmployee = options.workspacePathForEmployee;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? 15 * 60_000;
  }

  async reconcileOnce(): Promise<ReconcileResult> {
    this.pruneExitedDaemons();
    const employees = await this.backend.listEmployees();
    const nodes = await this.backend.listDaemonNodes();
    const nodesByEmployee = new Map<string, ControlPanelDaemonNodeRecord>();
    for (const node of nodes) {
      if (!node.employeeId) continue;
      const existing = nodesByEmployee.get(node.employeeId);
      if (!existing || nodeRank(node) < nodeRank(existing)) nodesByEmployee.set(node.employeeId, node);
    }

    let provisioned = 0;
    let started = 0;
    let skipped = 0;

    for (const employee of employees) {
      const workspacePath = this.workspacePathForEmployee(employee);
      let node = nodesByEmployee.get(employee.id);
      let env: Record<string, string> | undefined;
      if (!node) {
        const created = await this.backend.provisionDaemonNode({ employeeId: employee.id, workspacePath });
        node = created.node;
        env = created.daemonEnv;
        provisioned += 1;
        this.logger?.info("provisioned daemon node", { employeeId: employee.id, nodeId: node.id });
      }

      if (this.launcher.connectionMode === "http" && this.managed.has(node.id)) {
        if (node.online && !node.stale) {
          // Bootstrap ownership ends once the remote daemon reports over HTTP.
          this.managed.delete(node.id);
          this.launchedAt.delete(node.id);
        } else if (this.now() - (this.launchedAt.get(node.id) ?? 0) >= this.registrationTimeoutMs) {
          // Stop only the bootstrap command before retrying it. Remote daemon
          // lifecycle must be implemented idempotently by that command.
          await this.managed.get(node.id)!.stop();
          this.managed.delete(node.id);
          this.launchedAt.delete(node.id);
        }
      }
      if (!shouldStart(node) || this.managed.has(node.id)) {
        skipped += 1;
        continue;
      }

      if (!env) {
        const created = await this.backend.provisionDaemonNode({ employeeId: employee.id, workspacePath });
        node = created.node;
        env = created.daemonEnv;
      }
      const managed = await this.launcher.start({
        employee,
        node,
        env,
        workspacePath,
      });
      this.managed.set(node.id, managed);
      this.launchedAt.set(node.id, this.now());
      started += 1;
      this.logger?.info("started daemon node", { employeeId: employee.id, nodeId: node.id, provider: managed.provider });
    }

    return { employees: employees.length, provisioned, started, skipped };
  }

  async stop(): Promise<void> {
    const daemons = [...this.managed.values()];
    this.managed.clear();
    this.launchedAt.clear();
    if (this.launcher.connectionMode === "http") return;
    await Promise.allSettled(daemons.map((daemon) => daemon.stop()));
  }

  private pruneExitedDaemons(): void {
    if (this.launcher.connectionMode === "http") return;
    for (const [nodeId, daemon] of this.managed) {
      if (!daemon.child) continue;
      if (daemon.child.exitCode === null && !daemon.child.signalCode) continue;
      this.managed.delete(nodeId);
      this.logger?.warn("removed exited daemon from supervisor state", {
        nodeId,
        key: daemon.key,
        provider: daemon.provider,
        exitCode: daemon.child.exitCode,
        signalCode: daemon.child.signalCode,
      });
    }
  }
}

function shouldStart(node: ControlPanelDaemonNodeRecord): boolean {
  if (node.online && !node.stale) return false;
  return true;
}

function nodeRank(node: ControlPanelDaemonNodeRecord): number {
  if (node.online && node.status === "ready") return 0;
  if (node.online) return 1;
  if (node.nodeToken) return 2;
  return 3;
}
