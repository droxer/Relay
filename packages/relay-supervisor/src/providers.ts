import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EnsureManagedNodeInput, ManagedNodeProvider, ProviderInstance, SupervisorLogger } from "./types.js";

export interface LocalProcessProviderOptions {
  command?: string;
  logger?: SupervisorLogger;
  signalProcess?: (pid: number, signal: NodeJS.Signals) => void;
  readProcessCommand?: (pid: number) => Promise<string | undefined>;
  readProcessStart?: (pid: number) => Promise<string | undefined>;
  stopTimeoutMs?: number;
  stopPollIntervalMs?: number;
  stateDirectory?: string;
  allocationStaleMs?: number;
}

const execFileAsync = promisify(execFile);

export class LocalProcessProvider implements ManagedNodeProvider {
  readonly name = "local-process";
  private readonly command: string;
  private readonly logger?: SupervisorLogger;
  private readonly children = new Map<string, ChildProcess>();
  private readonly instancesByGeneration = new Map<string, string>();
  private readonly attemptsByGeneration = new Map<string, string>();
  private readonly generationByInstance = new Map<string, string>();
  private readonly pendingEnsures = new Map<string, Promise<ProviderInstance>>();
  private readonly signalProcess: (pid: number, signal: NodeJS.Signals) => void;
  private readonly readProcessCommand: (pid: number) => Promise<string | undefined>;
  private readonly readProcessStart: (pid: number) => Promise<string | undefined>;
  private readonly stopTimeoutMs: number;
  private readonly stopPollIntervalMs: number;
  private readonly stateDirectory: string;
  private readonly allocationStaleMs: number;

  constructor(options: LocalProcessProviderOptions = {}) {
    this.command = options.command ?? "relay-daemon";
    this.logger = options.logger;
    this.signalProcess = options.signalProcess ?? ((pid, signal) => { process.kill(pid, signal); });
    this.readProcessCommand = options.readProcessCommand ?? readProcessCommand;
    this.readProcessStart = options.readProcessStart ?? readProcessStart;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 5_000;
    this.stopPollIntervalMs = options.stopPollIntervalMs ?? 50;
    this.stateDirectory = options.stateDirectory ?? join(process.cwd(), ".relay", "supervisor", "local-process");
    this.allocationStaleMs = options.allocationStaleMs ?? 60_000;
  }

  async ensure(input: EnsureManagedNodeInput): Promise<ProviderInstance> {
    const generationKey = `${input.node.id}:${input.node.generation}`;
    const instanceId = this.instancesByGeneration.get(generationKey);
    const current = instanceId ? this.children.get(instanceId) : undefined;
    if (instanceId && current && current.exitCode === null && !current.signalCode) {
      if (this.attemptsByGeneration.get(generationKey) === input.attempt.id) {
        return { id: instanceId, child: current };
      }
      await this.stop(instanceId);
    }
    const pending = this.pendingEnsures.get(generationKey);
    if (pending) return pending;
    const statePath = this.statePath(generationKey);
    const durable = readProviderState(statePath);
    if (durable?.instanceId) {
      if (await this.inspect(durable.instanceId) === "running") {
        const belongsToAttempt = durable.attemptId === input.attempt.id
          || (!durable.attemptId && input.attempt.providerInstanceId === durable.instanceId);
        if (belongsToAttempt) {
          this.instancesByGeneration.set(generationKey, durable.instanceId);
          this.attemptsByGeneration.set(generationKey, input.attempt.id);
          this.generationByInstance.set(durable.instanceId, generationKey);
          return { id: durable.instanceId };
        }
        await this.stop(durable.instanceId);
      }
      rmSync(statePath, { force: true });
    } else if (durable?.status === "allocating") {
      const createdAt = durable.createdAt ? Date.parse(durable.createdAt) : Number.NaN;
      const stale = Number.isNaN(createdAt) || Date.now() - createdAt >= this.allocationStaleMs;
      if (!stale) {
        throw new Error(`Managed node ${generationKey} has an indeterminate local process allocation; refusing to create a duplicate.`);
      }
      rmSync(statePath, { force: true });
      this.logger?.warn("discarding stale managed local process allocation", { generationKey });
    }
    mkdirSync(this.stateDirectory, { recursive: true });
    writeProviderState(statePath, {
      status: "allocating",
      attemptId: input.attempt.id,
      createdAt: new Date().toISOString(),
    });
    const started = this.start(input, generationKey).then((instance) => {
      writeProviderState(statePath, { status: "running", attemptId: input.attempt.id, instanceId: instance.id });
      return instance;
    }).catch((error) => {
      rmSync(statePath, { force: true });
      throw error;
    });
    this.pendingEnsures.set(generationKey, started);
    try {
      return await started;
    } finally {
      this.pendingEnsures.delete(generationKey);
    }
  }

  private async start(input: EnsureManagedNodeInput, generationKey: string): Promise<ProviderInstance> {
    mkdirSync(input.workspacePath, { recursive: true });
    const child = spawn(this.command, [
      "--backend-url", input.backendUrl,
      "--workspace", input.workspacePath,
      "--workspace-id", input.workspaceId,
      "--sandbox", input.node.sandboxMode,
    ], {
      cwd: input.workspacePath,
      env: managedDaemonEnv(input),
      detached: true,
      stdio: "inherit",
    });
    await waitForSpawn(child);
    child.on("error", (error) => {
      this.logger?.warn("managed local process error", {
        pid: child.pid,
        error: error.message,
      });
    });
    if (!child.pid) {
      await terminateChild(child, this.stopTimeoutMs);
      throw new Error("Managed daemon process started without a pid.");
    }
    let processStart: string | undefined;
    try {
      processStart = await this.readProcessStart(child.pid);
      if (!processStart) {
        throw new Error("Managed daemon process start identity could not be read.");
      }
    } catch (error) {
      try {
        await terminateChild(child, this.stopTimeoutMs);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Managed daemon initialization failed and its process could not be terminated.",
        );
      }
      throw error;
    }
    const workspaceIdentity = encodeIdentity(input.workspaceId);
    const processIdentity = encodeIdentity(processStart);
    const instanceId = `local-process:${child.pid}:${workspaceIdentity}:${processIdentity}`;
    this.children.set(instanceId, child);
    this.instancesByGeneration.set(generationKey, instanceId);
    this.attemptsByGeneration.set(generationKey, input.attempt.id);
    this.generationByInstance.set(instanceId, generationKey);
    child.once("exit", (code, signal) => {
      this.children.delete(instanceId);
      if (this.instancesByGeneration.get(generationKey) === instanceId) {
        this.instancesByGeneration.delete(generationKey);
        this.attemptsByGeneration.delete(generationKey);
      }
      this.generationByInstance.delete(instanceId);
      this.clearState(generationKey, instanceId);
      this.logger?.warn("managed local process exited", { instanceId, code, signal });
    });
    child.unref();
    return { id: instanceId, child };
  }

  async inspect(instanceId: string): Promise<"running" | "stopped" | "unknown"> {
    const child = this.children.get(instanceId);
    if (child) return child.exitCode === null && !child.signalCode ? "running" : "stopped";
    const identity = localProcessIdentity(instanceId);
    if (!identity) return "unknown";
    const [command, processStart] = await Promise.all([
      this.readProcessCommand(identity.pid),
      this.readProcessStart(identity.pid),
    ]);
    if (!command || !processStart) return "stopped";
    return command.includes("relay-daemon")
      && command.includes(identity.workspaceId)
      && processStart === identity.processStart
      ? "running"
      : "unknown";
  }

  async stop(instanceId: string): Promise<void> {
    const child = this.children.get(instanceId);
    if (child) {
      await terminateChild(child, this.stopTimeoutMs, instanceId);
      return;
    }
    const identity = localProcessIdentity(instanceId);
    if (!identity || await this.inspect(instanceId) !== "running") return;
    try {
      this.signalProcess(identity.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    if (await this.waitUntilStopped(instanceId)) return;
    this.signalProcess(identity.pid, "SIGKILL");
    if (!await this.waitUntilStopped(instanceId)) {
      throw new Error(`Managed daemon ${instanceId} did not exit.`);
    }
  }

  async delete(instanceId: string): Promise<void> {
    await this.stop(instanceId);
    this.children.delete(instanceId);
    const generationKey = this.generationByInstance.get(instanceId);
    if (generationKey && this.instancesByGeneration.get(generationKey) === instanceId) {
      this.instancesByGeneration.delete(generationKey);
      this.attemptsByGeneration.delete(generationKey);
    }
    this.generationByInstance.delete(instanceId);
    if (generationKey) this.clearState(generationKey, instanceId);
  }

  private statePath(generationKey: string): string {
    return join(this.stateDirectory, `${encodeIdentity(generationKey)}.json`);
  }

  private clearState(generationKey: string, instanceId: string): void {
    const path = this.statePath(generationKey);
    if (readProviderState(path)?.instanceId === instanceId) {
      rmSync(path, { force: true });
    }
  }

  private async waitUntilStopped(instanceId: string): Promise<boolean> {
    const deadline = Date.now() + this.stopTimeoutMs;
    do {
      if (await this.inspect(instanceId) !== "running") return true;
      if (Date.now() >= deadline) return false;
      await delay(this.stopPollIntervalMs);
    } while (true);
  }
}

// The daemon resolves its identity from the environment before it looks at the
// enrollment credential, so any of these inherited from the supervisor's shell
// (or from a .env that relay-core auto-loads into this process) would silently
// win over the grant: RELAY_SANDBOX_ID skips enrollment entirely and binds the
// managed node's process to an unrelated node, and a stale daemon token loses
// registration with a 401. Drop them so enrollment is the only identity source.
const MANAGED_DAEMON_ENV_DENY = [
  "RELAY_DAEMON_NODE_TOKEN",
  "RELAY_DAEMON_TOKEN",
  "RELAY_EMPLOYEE_ID",
  "RELAY_SANDBOX_ID",
] as const;

export function managedDaemonEnv(input: EnsureManagedNodeInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of MANAGED_DAEMON_ENV_DENY) delete env[key];
  const boxliteProxy = env.RELAY_BOXLITE_PROXY_URL?.trim();
  if (boxliteProxy) {
    env.HTTP_PROXY = boxliteProxy;
    env.HTTPS_PROXY = boxliteProxy;
    env.ALL_PROXY = boxliteProxy;
    env.http_proxy = boxliteProxy;
    env.https_proxy = boxliteProxy;
    env.all_proxy = boxliteProxy;
    const noProxy = mergeNoProxy(env.NO_PROXY ?? env.no_proxy, ["localhost", "127.0.0.1", "::1"]);
    env.NO_PROXY = noProxy;
    env.no_proxy = noProxy;
  }
  return {
    ...env,
    RELAY_BACKEND_URL: input.backendUrl,
    RELAY_ENROLLMENT_TOKEN: input.enrollmentCredential,
    RELAY_WORKSPACE: input.workspacePath,
    RELAY_WORKSPACE_ID: input.workspaceId,
    RELAY_SANDBOX_MODE: input.node.sandboxMode,
  };
}

function mergeNoProxy(current: string | undefined, required: string[]): string {
  const entries = (current ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  for (const entry of required) {
    if (!entries.includes(entry)) entries.push(entry);
  }
  return entries.join(",");
}

interface ProviderState {
  status: "allocating" | "running";
  attemptId?: string;
  instanceId?: string;
  createdAt?: string;
}

function readProviderState(path: string): ProviderState | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as ProviderState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function writeProviderState(path: string, state: ProviderState): void {
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(state), { mode: 0o600 });
  renameSync(temporaryPath, path);
}

function localProcessIdentity(instanceId: string): { pid: number; workspaceId: string; processStart: string } | undefined {
  const match = /^local-process:(\d+):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(instanceId);
  if (!match) return undefined;
  const pid = Number(match[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  try {
    return {
      pid,
      workspaceId: Buffer.from(match[2], "base64url").toString("utf8"),
      processStart: Buffer.from(match[3], "base64url").toString("utf8"),
    };
  } catch {
    return undefined;
  }
}

function encodeIdentity(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

async function waitForSpawn(child: ChildProcess): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onSpawn = () => {
      child.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      child.off("spawn", onSpawn);
      reject(error);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function terminateChild(
  child: ChildProcess,
  timeoutMs: number,
  instanceId = `pid:${child.pid ?? "unknown"}`,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode) return;
  child.kill("SIGTERM");
  await waitForChildExit(child, timeoutMs);
  if (child.exitCode === null && !child.signalCode) {
    child.kill("SIGKILL");
    await waitForChildExit(child, timeoutMs);
  }
  if (child.exitCode === null && !child.signalCode) {
    throw new Error(`Managed daemon ${instanceId} did not exit.`);
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readProcessCommand(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "command="]);
    const command = stdout.trim();
    return command || undefined;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === "ESRCH") return undefined;
    throw error;
  }
}

async function readProcessStart(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="]);
    const start = stdout.trim();
    return start || undefined;
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 1 || code === "ESRCH") return undefined;
    throw error;
  }
}
