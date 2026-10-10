import type { AgentName, AgentOutputSink, StreamExecResult } from "relay-core";

import {
  activeBox,
  collectExecution,
  ensureLocalDevboxOci,
  prepareGuestAgentAuth,
  prepareGuestAgentSkills,
  prepareGuestWorkspace,
  stopSessionBox,
  type DevboxOciOptions,
} from "./box.js";

type BoxLiteRuntime = any;
type BoxLiteBox = any;
type StreamRenderer = (chunk: string) => string;

export interface SandboxMount {
  hostPath: string;
  guestPath: string;
  readOnly: boolean;
}

export interface CreateSandboxInput {
  rootfsPath: string;
  boxName: string;
  volumes: SandboxMount[];
  env: Array<{ key: string; value: string }>;
  workingDir: string;
  autoRemove: boolean;
}

export interface ExecutionSandbox {
  name: string;
  raw: BoxLiteBox;
}

export interface ExecutionManager {
  ensureImage(sink?: AgentOutputSink, options?: DevboxOciOptions): string;
  createSandbox(runtime: BoxLiteRuntime, input: CreateSandboxInput): Promise<ExecutionSandbox>;
  setActiveSandbox(sandbox: ExecutionSandbox | null): void;
  stopActiveSandbox(): Promise<void>;
  removeSandbox(runtime: BoxLiteRuntime, boxName: string): Promise<void>;
  prepareWorkspace(hostWorkspace: string): Promise<[number, number]>;
  prepareAgentAuth(agents: Iterable<AgentName>, signal?: AbortSignal): Promise<void>;
  prepareAgentSkills(signal?: AbortSignal): Promise<void>;
  execStream(
    cmd: string,
    args?: string[],
    options?: {
      cwd?: string;
      stdoutRenderer?: StreamRenderer;
      stderrRenderer?: StreamRenderer;
      sink?: AgentOutputSink;
      signal?: AbortSignal;
      env?: Record<string, string>;
    },
  ): Promise<StreamExecResult>;
  runShell(command: string, signal?: AbortSignal, env?: Record<string, string>): Promise<StreamExecResult>;
}

/**
 * One manager drives one guest. The daemon keeps a manager per pooled guest so
 * concurrent runs each exec into their own VM; a manager with no guest of its
 * own falls back to the process-wide session box used by single-guest callers.
 */
export class BoxLiteExecutionManager implements ExecutionManager {
  private sandbox: ExecutionSandbox | null = null;

  ensureImage(sink?: AgentOutputSink, options?: DevboxOciOptions): string {
    return ensureLocalDevboxOci(sink, options);
  }

  async createSandbox(runtime: BoxLiteRuntime, input: CreateSandboxInput): Promise<ExecutionSandbox> {
    const box = await createSessionBox(runtime, {
      rootfsPath: input.rootfsPath,
      volumes: input.volumes,
      env: input.env,
      workingDir: input.workingDir,
      autoRemove: input.autoRemove,
    }, input.boxName);
    return { name: input.boxName, raw: box };
  }

  setActiveSandbox(sandbox: ExecutionSandbox | null): void {
    this.sandbox = sandbox;
  }

  async stopActiveSandbox(): Promise<void> {
    const sandbox = this.sandbox;
    this.sandbox = null;
    if (sandbox) await sandbox.raw.stop();
    else await stopSessionBox();
  }

  async removeSandbox(runtime: BoxLiteRuntime, boxName: string): Promise<void> {
    if (!runtime.remove) return;
    await runtime.remove(boxName, true).catch((error: unknown) => {
      if (!isMissingBoxError(error)) throw error;
    });
  }

  async prepareWorkspace(hostWorkspace: string): Promise<[number, number]> {
    return prepareGuestWorkspace(hostWorkspace, this.box());
  }

  async prepareAgentAuth(agents: Iterable<AgentName>, signal?: AbortSignal): Promise<void> {
    await prepareGuestAgentAuth(agents, signal, this.sandbox?.raw);
  }

  async prepareAgentSkills(signal?: AbortSignal): Promise<void> {
    await prepareGuestAgentSkills(signal, this.sandbox?.raw);
  }

  async execStream(
    cmd: string,
    args: string[] = [],
    options: {
      cwd?: string;
      stdoutRenderer?: StreamRenderer;
      stderrRenderer?: StreamRenderer;
      sink?: AgentOutputSink;
      signal?: AbortSignal;
      env?: Record<string, string>;
    } = {},
  ): Promise<StreamExecResult> {
    if (options.signal?.aborted) {
      return { exit_code: -1, stdout: "", stderr: "", error_message: "Execution cancelled before start." };
    }
    const env = options.env ? Object.entries(options.env) : null;
    const execution = await this.box().exec(cmd, args, env, false, null, null, options.cwd ?? null);
    // Daemon runs stream to the backend, not the daemon's terminal — the same
    // as local execution, which never echoes.
    return collectExecution(execution, false, options.stdoutRenderer, options.stderrRenderer, options.sink, options.signal);
  }

  async runShell(command: string, signal?: AbortSignal, env?: Record<string, string>): Promise<StreamExecResult> {
    const execution = await this.box().exec("bash", ["-c", command], env ? Object.entries(env) : null);
    return collectExecution(execution, false, undefined, undefined, undefined, signal);
  }

  private box(): BoxLiteBox {
    return this.sandbox?.raw ?? activeBox();
  }
}

async function createSessionBox(runtime: BoxLiteRuntime, options: unknown, boxName: string): Promise<BoxLiteBox> {
  if (runtime.getOrCreate) {
    try {
      const result = await runtime.getOrCreate(options, boxName);
      return result.box;
    } catch (error) {
      if (!isExistingBoxError(error) || !runtime.remove) throw error;
      await runtime.remove(boxName, true).catch(() => undefined);
      const result = await runtime.getOrCreate(options, boxName);
      return result.box;
    }
  }
  try {
    return await runtime.create(options, boxName);
  } catch (error) {
    if (!isExistingBoxError(error) || !runtime.remove) throw error;
    await runtime.remove(boxName, true).catch(() => undefined);
    return runtime.create(options, boxName);
  }
}

function isExistingBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /box with name .+ already exists/i.test(message) || /already exists/i.test(message);
}

function isMissingBoxError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /box not found/i.test(message) || /not found/i.test(message);
}

export const defaultExecutionManager = new BoxLiteExecutionManager();
