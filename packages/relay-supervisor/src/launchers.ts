import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { DaemonLaunchRequest, DaemonLauncher, ManagedDaemon, SupervisorLogger } from "./types.js";

export interface LocalDaemonLauncherOptions {
  backendUrl: string;
  workspaceRoot: string;
  sandboxMode?: "none" | "boxlite";
  command?: string;
  logger?: SupervisorLogger;
}
export interface CommandTemplateLauncherOptions {
  name?: string;
  command: string;
  cwd?: string;
  logger?: SupervisorLogger;
}

export function workspaceForEmployee(workspaceRoot: string, employeeId: string): string {
  return resolve(workspaceRoot, safePathSegment(employeeId));
}

export function workspaceForManagedNode(workspaceRoot: string, nodeId: string): string {
  return resolve(workspaceRoot, safePathSegment(nodeId));
}

export class LocalDaemonLauncher implements DaemonLauncher {
  readonly name = "local";
  private readonly backendUrl: string;
  private readonly workspaceRoot: string;
  private readonly sandboxMode: "none" | "boxlite";
  private readonly command: string;
  private readonly logger?: SupervisorLogger;

  constructor(options: LocalDaemonLauncherOptions) {
    this.backendUrl = options.backendUrl.replace(/\/+$/, "");
    this.workspaceRoot = options.workspaceRoot;
    this.sandboxMode = options.sandboxMode ?? "boxlite";
    this.command = options.command ?? "relay-daemon";
    this.logger = options.logger;
  }

  async start(request: DaemonLaunchRequest): Promise<ManagedDaemon> {
    mkdirSync(request.workspacePath, { recursive: true });
    const child = spawn(this.command, [
      "--backend-url",
      this.backendUrl,
      "--sandbox-id",
      request.node.id,
      "--employee-id",
      request.employee.id,
      "--token",
      requiredToken(request),
      "--sandbox",
      this.sandboxMode,
    ], {
      cwd: request.workspacePath,
      env: {
        ...process.env,
        ...request.env,
        RELAY_BACKEND_URL: this.backendUrl,
        RELAY_EMPLOYEE_ID: request.employee.id,
        RELAY_SANDBOX_ID: request.node.id,
        RELAY_DAEMON_NODE_TOKEN: requiredToken(request),
        RELAY_WORKSPACE: request.workspacePath,
        RELAY_SANDBOX_MODE: this.sandboxMode,
      },
      stdio: "inherit",
    });
    return managedChild(`${request.employee.id}:${request.node.id}`, this.name, child, this.logger);
  }

  workspacePath(employeeId: string): string {
    return workspaceForEmployee(this.workspaceRoot, employeeId);
  }
}

export class CommandTemplateLauncher implements DaemonLauncher {
  readonly connectionMode = "http" as const;
  readonly name: string;
  private readonly command: string;
  private readonly cwd?: string;
  private readonly logger?: SupervisorLogger;

  constructor(options: CommandTemplateLauncherOptions) {
    this.name = options.name ?? "command";
    this.command = options.command;
    this.cwd = options.cwd;
    this.logger = options.logger;
  }

  async start(request: DaemonLaunchRequest): Promise<ManagedDaemon> {
    const rendered = renderTemplate(this.command, {
      employeeId: request.employee.id,
      sandboxId: request.node.id,
      nodeToken: requiredToken(request),
      workspacePath: request.workspacePath,
      backendUrl: request.env.RELAY_BACKEND_URL ?? "",
    });
    const child = spawn(rendered, {
      cwd: this.cwd ?? process.cwd(),
      env: { ...process.env, ...request.env },
      shell: true,
      stdio: "inherit",
    });
    return managedChild(`${request.employee.id}:${request.node.id}`, this.name, child, this.logger);
  }
}

function managedChild(key: string, provider: string, child: ChildProcess, logger?: SupervisorLogger): ManagedDaemon {
  child.once("exit", (code, signal) => {
    logger?.warn("daemon launcher child exited", { key, provider, code, signal });
  });
  return {
    key,
    provider,
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode) return;
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    },
  };
}

function requiredToken(request: DaemonLaunchRequest): string {
  const token = request.env.RELAY_DAEMON_NODE_TOKEN;
  if (!token) throw new Error(`Daemon node ${request.node.id} has no node token available for supervisor launch.`);
  return token;
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{\{([a-zA-Z0-9_]+)\}\}/g, (_match, key: string) => shellQuote(values[key] ?? ""));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function safePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_") || "employee";
}
