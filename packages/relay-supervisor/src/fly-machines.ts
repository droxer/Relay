import type { EnsureManagedNodeInput, ManagedNodeProvider, ProviderInstance, SupervisorLogger } from "./types.js";

/**
 * Realizes a managed computer as one Fly Machine plus one Fly volume.
 *
 * The machine is the computer's isolation boundary (a Firecracker microVM), so
 * the daemon runs agents directly in it with sandboxMode "none". Everything
 * that must outlive the machine — the node workspace, the daemon's private
 * state, and agent logins under HOME — lives on the volume at /data, so a new
 * provisioning attempt reuses the same machine and volume and only swaps in the
 * new enrollment grant.
 */
export const FLY_MACHINES_PROVIDER = "fly-machines";

const DEFAULT_API_BASE_URL = "https://api.machines.dev/v1";
const DATA_MOUNT = "/data";
const NODE_METADATA_KEY = "relay_managed_node";
const GENERATION_METADATA_KEY = "relay_generation";
const ATTEMPT_METADATA_KEY = "relay_attempt";
// States in which the machine is, or is about to be, running the daemon.
const RUNNING_STATES = new Set(["created", "starting", "started", "replacing", "updating"]);
const GONE_STATES = new Set(["destroying", "destroyed"]);
// Settled states an update or a new start may safely act on.
const HALTED_STATES = new Set(["stopped", "suspended"]);
const TRANSITIONING_STATES = new Set(["stopping", "suspending"]);
const GONE_VOLUME_STATES = new Set(["destroyed", "pending_destroy", "scheduling_destroy"]);
// Start/stop on a machine already in that state answers 409 or 412.
const ALREADY_IN_STATE = new Set([409, 412]);
const STATE_POLL_ATTEMPTS = 30;
const STATE_POLL_INTERVAL_MS = 2_000;
// The daemon drains (a draining heartbeat, then run aborts) on SIGTERM; Fly's
// default 5 s before SIGKILL is too short for that.
const STOP_CONFIG = { signal: "SIGTERM", timeout: "30s" };
// Fly volume names: lowercase letters, digits, and underscores, at most 30.
const VOLUME_NAME_PREFIX = "relay_";
const VOLUME_NAME_ID_LENGTH = 24;

export interface FlyMachinesConfig {
  apiToken: string;
  app: string;
  image: string;
  region: string;
  cpuKind: "shared" | "performance";
  cpus: number;
  memoryMb: number;
  volumeSizeGb: number;
  apiBaseUrl?: string;
}

export interface FlyMachinesProviderOptions {
  config: FlyMachinesConfig;
  fetch?: typeof fetch;
  logger?: SupervisorLogger;
  sleep?: (ms: number) => Promise<void>;
}

interface FlyMachine {
  id: string;
  name?: string;
  state: string;
  config?: {
    metadata?: Record<string, string>;
    mounts?: Array<{ volume?: string }>;
  };
}

interface FlyVolume {
  id: string;
  name: string;
  state: string;
  attached_machine_id?: string | null;
}

export class FlyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "FlyApiError";
  }
}

export class FlyMachinesProvider implements ManagedNodeProvider {
  readonly name = FLY_MACHINES_PROVIDER;
  private readonly config: FlyMachinesConfig;
  private readonly fetchFn: typeof fetch;
  private readonly logger?: SupervisorLogger;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: FlyMachinesProviderOptions) {
    this.config = options.config;
    this.fetchFn = options.fetch ?? fetch;
    this.logger = options.logger;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ensure(input: EnsureManagedNodeInput): Promise<ProviderInstance> {
    const nodeId = input.node.id;
    if (input.node.sandboxMode !== "none") {
      throw new Error(
        `Managed node ${nodeId} must use sandboxMode none: a Fly Machine has no /dev/kvm for BoxLite.`,
      );
    }
    const existing = await this.findMachine(nodeId);
    const existingVolumeId = existing ? mountedVolumeId(existing) : undefined;
    if (existing && existingVolumeId
      && existing.config?.metadata?.[ATTEMPT_METADATA_KEY] === input.attempt.id
      && RUNNING_STATES.has(existing.state)) {
      return { id: instanceId(existing.id, existingVolumeId) };
    }
    if (!existing) return this.createMachine(input);
    const volumeId = existingVolumeId ?? (await this.ensureVolume(nodeId)).volume.id;
    // An update is refused mid-transition, so let a stop or suspend finish.
    if (TRANSITIONING_STATES.has(existing.state)) await this.waitForHalted(existing.id);
    // A snapshot would resume the old daemon with the retired identity, so a
    // suspended machine is cold-stopped before it takes the new grant.
    if (existing.state === "suspended" || existing.state === "suspending") await this.stopMachine(existing.id);
    const config = this.machineConfig(input, volumeId);
    const updated = await this.request<FlyMachine>("POST", `/machines/${existing.id}`, { config });
    if (!RUNNING_STATES.has(updated.state)) await this.startMachine(existing.id);
    this.logger?.info("fly machine relaunched", { nodeId, machineId: existing.id, volumeId });
    return { id: instanceId(existing.id, volumeId) };
  }

  private async createMachine(input: EnsureManagedNodeInput): Promise<ProviderInstance> {
    const nodeId = input.node.id;
    const { volume, created: createdVolume } = await this.ensureVolume(nodeId);
    let machine: FlyMachine;
    try {
      machine = await this.request<FlyMachine>("POST", "/machines", {
        name: `relay-${nodeId}`,
        region: this.config.region,
        config: this.machineConfig(input, volume.id),
      });
    } catch (error) {
      // No attempt records an instance id until ensure returns, so a volume
      // this call created would be unreachable by a later delete.
      if (createdVolume) await this.discardVolume(volume.id, nodeId);
      throw error;
    }
    this.logger?.info("fly machine created", { nodeId, machineId: machine.id, volumeId: volume.id });
    return { id: instanceId(machine.id, volume.id) };
  }

  private async discardVolume(volumeId: string, nodeId: string): Promise<void> {
    try {
      await this.tolerate([404], () => this.request("DELETE", `/volumes/${volumeId}`));
    } catch (error) {
      this.logger?.warn("fly volume rollback failed", {
        nodeId,
        volumeId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async inspect(id: string): Promise<"running" | "stopped" | "unknown"> {
    const machine = await this.getMachine(parseInstanceId(id).machineId);
    if (!machine) return "stopped";
    return RUNNING_STATES.has(machine.state) ? "running" : "stopped";
  }

  async stop(id: string): Promise<void> {
    await this.stopMachine(parseInstanceId(id).machineId);
  }

  async delete(id: string): Promise<void> {
    const { machineId, volumeId } = parseInstanceId(id);
    await this.tolerate([404], () => this.request("DELETE", `/machines/${machineId}?force=true`));
    await this.waitFor(machineId, (machine) => !machine || machine.state === "destroyed", "destroyed");
    await this.tolerate([404], () => this.request("DELETE", `/volumes/${volumeId}`));
    this.logger?.info("fly machine and volume deleted", { machineId, volumeId });
  }

  private machineConfig(input: EnsureManagedNodeInput, volumeId: string): Record<string, unknown> {
    return {
      image: this.config.image,
      env: {
        RELAY_BACKEND_URL: input.backendUrl,
        RELAY_ENROLLMENT_TOKEN: input.enrollmentCredential,
        RELAY_WORKSPACE: `${DATA_MOUNT}/workspace`,
        RELAY_WORKSPACE_ID: input.workspaceId,
        RELAY_SANDBOX_MODE: "none",
        // The machine is the sandbox; see the class comment.
        RELAY_ALLOW_HOST_AGENT_EXECUTION: "1",
        // Daemon state (~/.relay) and agent logins persist on the volume.
        HOME: `${DATA_MOUNT}/home`,
        RELAY_DAEMON_ECHO_AGENT_OUTPUT: "0",
      },
      guest: { cpu_kind: this.config.cpuKind, cpus: this.config.cpus, memory_mb: this.config.memoryMb },
      mounts: [{ volume: volumeId, path: DATA_MOUNT }],
      restart: { policy: "on-failure", max_retries: 10 },
      stop_config: STOP_CONFIG,
      auto_destroy: false,
      metadata: {
        [NODE_METADATA_KEY]: input.node.id,
        [GENERATION_METADATA_KEY]: String(input.node.generation),
        [ATTEMPT_METADATA_KEY]: input.attempt.id,
      },
    };
  }

  private async findMachine(nodeId: string): Promise<FlyMachine | undefined> {
    const query = new URLSearchParams({ [`metadata.${NODE_METADATA_KEY}`]: nodeId });
    const machines = await this.request<FlyMachine[]>("GET", `/machines?${query}`);
    return machines.find((machine) =>
      machine.config?.metadata?.[NODE_METADATA_KEY] === nodeId && !GONE_STATES.has(machine.state)
    );
  }

  private async ensureVolume(nodeId: string): Promise<{ volume: FlyVolume; created: boolean }> {
    const name = volumeNameFor(nodeId);
    const volumes = await this.request<FlyVolume[]>("GET", "/volumes");
    const existing = volumes.find((volume) =>
      volume.name === name && !GONE_VOLUME_STATES.has(volume.state) && !volume.attached_machine_id
    );
    if (existing) return { volume: existing, created: false };
    const created = await this.request<FlyVolume>("POST", "/volumes", {
      name,
      region: this.config.region,
      size_gb: this.config.volumeSizeGb,
      encrypted: true,
    });
    this.logger?.info("fly volume created", { nodeId, volumeId: created.id });
    return { volume: created, created: true };
  }

  private async getMachine(machineId: string): Promise<FlyMachine | undefined> {
    const machine = await this.tolerate([404], () => this.request<FlyMachine>("GET", `/machines/${machineId}`));
    return machine && !GONE_STATES.has(machine.state) ? machine : undefined;
  }

  private async startMachine(machineId: string): Promise<void> {
    await this.tolerate([...ALREADY_IN_STATE], () => this.request("POST", `/machines/${machineId}/start`));
  }

  /**
   * Stop is asynchronous on Fly, and a 409/412 does not always mean "already
   * stopped", so it returns only once the machine is observed halted or gone.
   */
  private async stopMachine(machineId: string): Promise<void> {
    await this.tolerate([404, ...ALREADY_IN_STATE], () => this.request("POST", `/machines/${machineId}/stop`));
    await this.waitForHalted(machineId);
  }

  private async waitForHalted(machineId: string): Promise<void> {
    await this.waitFor(
      machineId,
      (machine) => !machine || GONE_STATES.has(machine.state) || HALTED_STATES.has(machine.state),
      "stopped",
    );
  }

  /** Throws when the state never arrives; the reconciler retries the node next pass. */
  private async waitFor(
    machineId: string,
    reached: (machine: FlyMachine | undefined) => boolean,
    target: string,
  ): Promise<void> {
    for (let attempt = 0; attempt < STATE_POLL_ATTEMPTS; attempt += 1) {
      const machine = await this.tolerate([404], () => this.request<FlyMachine>("GET", `/machines/${machineId}`));
      if (reached(machine)) return;
      await this.sleep(STATE_POLL_INTERVAL_MS);
    }
    throw new Error(`Fly machine ${machineId} did not reach ${target} in time; retrying on a later pass.`);
  }

  private async tolerate<T>(statuses: number[], call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof FlyApiError && statuses.includes(error.status)) return undefined;
      throw error;
    }
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const base = this.config.apiBaseUrl ?? DEFAULT_API_BASE_URL;
    const url = `${base}/apps/${encodeURIComponent(this.config.app)}${path}`;
    const response = await this.fetchFn(url, {
      method,
      headers: { Authorization: `Bearer ${this.config.apiToken}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      const route = path.split("?")[0];
      throw new FlyApiError(response.status, `Fly API ${method} ${route} failed (${response.status}): ${text.slice(0, 300)}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** The provider instance id carries the volume so deletion can finish after the machine is gone. */
function instanceId(machineId: string, volumeId: string): string {
  return `${machineId}:${volumeId}`;
}

function parseInstanceId(id: string): { machineId: string; volumeId: string } {
  const [machineId, volumeId] = id.split(":");
  if (!machineId || !volumeId) throw new Error(`Malformed Fly provider instance id: ${id}`);
  return { machineId, volumeId };
}

function mountedVolumeId(machine: FlyMachine): string | undefined {
  return machine.config?.mounts?.find((mount) => mount.volume)?.volume;
}

export function volumeNameFor(nodeId: string): string {
  const compact = nodeId.toLowerCase().replace(/[^a-z0-9]/g, "");
  return `${VOLUME_NAME_PREFIX}${compact.slice(0, VOLUME_NAME_ID_LENGTH)}`;
}

/**
 * Reads the provider's settings, or returns undefined when RELAY_FLY_APP is
 * unset (the provider is simply not offered). A partial configuration throws
 * once, naming every missing or invalid variable.
 */
export function flyMachinesConfigFromEnv(env: NodeJS.ProcessEnv): FlyMachinesConfig | undefined {
  const app = env.RELAY_FLY_APP?.trim();
  if (!app) return undefined;
  const problems: string[] = [];
  const required = (value: string | undefined, name: string): string => {
    const trimmed = value?.trim();
    if (!trimmed) problems.push(`${name} is required`);
    return trimmed ?? "";
  };
  const positive = (name: string, fallback: number): number => {
    const raw = env[name]?.trim();
    if (!raw) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) problems.push(`${name} must be a positive integer`);
    return value;
  };
  const apiToken = required(env.RELAY_FLY_API_TOKEN ?? env.FLY_API_TOKEN, "FLY_API_TOKEN (or RELAY_FLY_API_TOKEN)");
  const image = required(env.RELAY_FLY_IMAGE, "RELAY_FLY_IMAGE");
  const region = required(env.RELAY_FLY_REGION, "RELAY_FLY_REGION");
  const cpuKind = env.RELAY_FLY_CPU_KIND?.trim() || "shared";
  if (cpuKind !== "shared" && cpuKind !== "performance") {
    problems.push("RELAY_FLY_CPU_KIND must be shared or performance");
  }
  const config: FlyMachinesConfig = {
    apiToken,
    app,
    image,
    region,
    cpuKind: cpuKind as FlyMachinesConfig["cpuKind"],
    cpus: positive("RELAY_FLY_CPUS", 2),
    memoryMb: positive("RELAY_FLY_MEMORY_MB", 4096),
    volumeSizeGb: positive("RELAY_FLY_VOLUME_GB", 20),
  };
  if (problems.length) throw new Error(`Fly Machines provider misconfigured: ${problems.join("; ")}.`);
  return config;
}
