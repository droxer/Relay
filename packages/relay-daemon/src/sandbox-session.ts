import {
  acquireBoxliteHomeLock,
  importBoxLite,
  type BoxliteHomeLock,
} from "./box.js";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEVBOX_IMAGE,
  GUEST_WORKSPACE,
  ansi,
  emitOrPrint,
  getAgent,
  agentCredentialEnv,
  guestAgentEnv,
  hostWorkspaceOwner,
  hostWorkspacePath,
  keyValue,
  piBaseUrl,
  piModel,
  piProvider,
  section,
  setSessionGuestEnv,
  type AgentName,
  type AgentOutputSink,
} from "relay-core";
import { defaultExecutionManager, type ExecutionManager } from "./execution.js";

export interface OrchestratorSession {
  rootfsPath: string;
  hostWorkspace: string;
  boxliteHome: string;
  hostUid: number;
  hostGid: number;
  syncedUid: number;
  syncedGid: number;
}

export interface OrchestratorSessionOptions {
  boxName?: string;
  workspacePath?: string;
  boxliteHome?: string;
  executionManager?: ExecutionManager;
  runtimeOwner?: BoxliteRuntimeOwner;
}

export interface ActiveOrchestratorSession {
  session: OrchestratorSession;
  close(): Promise<void>;
}

interface BoxliteRuntimeLifecycle {
  shutdown?(timeout?: number | null): Promise<void>;
  close?(): void;
}

// BoxLite 0.9.7 retains its native home lock after shutdown()/close(). Keep
// the runtime alive across guest replacements; only shut it down on daemon exit.
export class BoxliteRuntimeOwner {
  private pending?: Promise<BoxliteRuntimeLifecycle>;
  private homeLock?: BoxliteHomeLock;
  private closing?: Promise<void>;
  private closed = false;

  constructor(
    readonly home: string,
    private readonly create = async (): Promise<BoxliteRuntimeLifecycle> => {
      const { JsBoxlite } = await importBoxLite();
      return new JsBoxlite({ homeDir: home });
    },
  ) {}

  async get(): Promise<BoxliteRuntimeLifecycle> {
    if (this.closed) throw new Error("BoxLite runtime owner is closed; restart the daemon.");
    if (!this.pending) {
      this.homeLock = acquireBoxliteHomeLock(this.home);
      this.pending = this.create().catch((error: unknown) => {
        this.homeLock?.release();
        this.homeLock = undefined;
        this.pending = undefined;
        throw error;
      });
    }
    return this.pending;
  }

  close(): Promise<void> {
    this.closed = true;
    return this.closing ??= this.finish();
  }

  private async finish(): Promise<void> {
    if (this.pending) await shutdownBoxliteRuntime(await this.pending);
    // BoxLite 0.9.7 keeps its native home lock for the lifetime of the Node
    // process even after shutdown()/close(). Retain Relay's ownership marker
    // as well; the next process safely reclaims it after this PID exits.
  }
}

const readyAgents = new Set<AgentName>();

/**
 * A BoxLite home admits exactly one runtime at a time, so the home is the
 * daemon's private property: it is keyed by `sandboxId` and not by the
 * workspace alone. Several daemons on one host routinely share a workspace
 * (each employee's node registers against the same repo root), and keying on
 * the workspace pointed all of them at one home — whichever started second
 * failed every run with "Another BoxliteRuntime is already using directory".
 *
 * The sandbox id joins the digest rather than the path because BoxLite opens
 * Unix sockets beneath this home and macOS caps a socket path at 104 bytes; a
 * 36-character uuid spent on a path segment overruns that budget, while the
 * digest stays 12 characters wide however long the id is. `sandboxId` is
 * stable for a daemon's life, so its home — and the image cache in it —
 * survives restarts.
 */
export function resolveBoxliteHome(
  hostWorkspace: string,
  override = process.env.RELAY_BOXLITE_HOME,
  sandboxId?: string,
): string {
  const explicit = override?.trim();
  if (explicit) return resolve(explicit);
  const workspacePath = resolve(hostWorkspace);
  const key = sandboxId ? `${sandboxId}\0${workspacePath}` : workspacePath;
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 12);
  return join(homedir(), ".relay", "boxlite", digest);
}

export function resetAgentReadiness(): void {
  readyAgents.clear();
}

export async function shutdownBoxliteRuntime(runtime: BoxliteRuntimeLifecycle): Promise<void> {
  try {
    await runtime.shutdown?.();
  } finally {
    runtime.close?.();
  }
}

export async function ensureAgentReady(
  agent: AgentName,
  sink?: AgentOutputSink,
  signal?: AbortSignal,
  executionManager: ExecutionManager = defaultExecutionManager,
): Promise<void> {
  if (readyAgents.has(agent)) return;
  if (signal?.aborted) throw new Error(`${agent} readiness cancelled.`);
  const def = getAgent(agent);
  if (def.needsGuestAuth) {
    await executionManager.prepareAgentAuth([agent], signal);
  }
  // Skills are shared across every agent under ~/.claude/skills.
  await executionManager.prepareAgentSkills(signal);
  const result = await executionManager.runShell(
    def.preflight.command(),
    signal,
    Object.fromEntries(agentCredentialEnv(agent)),
  );
  if (result.exit_code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new Error(`${def.preflight.label} preflight failed. ${detail}`);
  }
  readyAgents.add(agent);
}

export async function startOrchestratorSession(
  sink?: AgentOutputSink,
  options: OrchestratorSessionOptions = {},
): Promise<ActiveOrchestratorSession> {
  const executionManager = options.executionManager ?? defaultExecutionManager;
  const hostWorkspace = options.workspacePath ?? hostWorkspacePath();
  const boxliteHome = resolveBoxliteHome(hostWorkspace, options.boxliteHome);
  if (options.runtimeOwner && resolve(options.runtimeOwner.home) !== boxliteHome) {
    throw new Error("BoxLite runtime owner does not match the session home.");
  }
  resetAgentReadiness();
  if (!sink) {
    console.log(section("Relay", ansi.cyan));
    console.log(keyValue("image", DEVBOX_IMAGE));
    console.log(keyValue("mount", GUEST_WORKSPACE));
  } else {
    sink(`${keyValue("image", DEVBOX_IMAGE)}\n`);
    sink(`${keyValue("mount", GUEST_WORKSPACE)}\n`);
  }
  const rootfsPath = executionManager.ensureImage(sink);
  mkdirSync(boxliteHome, { recursive: true });
  let homeLock: BoxliteHomeLock | undefined;
  let runtime: any | undefined;
  const boxName = options.boxName ?? "relay";
  const close = async (): Promise<void> => {
    try {
      resetAgentReadiness();
      if (runtime) {
        await executionManager.stopActiveSandbox();
        await executionManager.removeSandbox(runtime, boxName);
      }
    } finally {
      try {
        if (runtime && !options.runtimeOwner) await shutdownBoxliteRuntime(runtime);
      } finally {
        homeLock?.release();
      }
    }
  };
  try {
    if (options.runtimeOwner) {
      runtime = await options.runtimeOwner.get();
    } else {
      homeLock = acquireBoxliteHomeLock(boxliteHome);
      const { JsBoxlite } = await importBoxLite();
      runtime = new JsBoxlite({ homeDir: boxliteHome });
    }
    const [hostUid, hostGid] = hostWorkspaceOwner(hostWorkspace);
    const guestEnv = guestAgentEnv(hostWorkspace);
    setSessionGuestEnv(guestEnv);
    const env = guestEnv.map(([key, value]) => ({ key, value }));
    const sandbox = await executionManager.createSandbox(runtime, {
      rootfsPath,
      boxName,
      volumes: [{ hostPath: hostWorkspace, guestPath: GUEST_WORKSPACE, readOnly: false }],
      env,
      workingDir: GUEST_WORKSPACE,
      autoRemove: true,
    });
    executionManager.setActiveSandbox(sandbox);
    emitOrPrint(sink, keyValue("box", boxName));
    emitOrPrint(sink, keyValue("rootfs", rootfsPath));
    emitOrPrint(sink, keyValue("workspace", hostWorkspace));
    emitOrPrint(sink, keyValue("boxlite-home", boxliteHome));

    const [syncedUid, syncedGid] = await executionManager.prepareWorkspace(hostWorkspace);
    emitOrPrint(sink, keyValue("owner", `uid=${syncedUid} gid=${syncedGid} (host uid=${hostUid} gid=${hostGid})`));
    emitOrPrint(sink, keyValue("codex", `provider=dashscope base_url=${process.env.OPENAI_BASE_URL || "(default)"}`));
    emitOrPrint(sink, keyValue("pi", `provider=${piProvider()} model=${piModel() || "(default)"} base_url=${piBaseUrl() || "(default)"}`));

    return {
      session: {
        rootfsPath,
        hostWorkspace,
        boxliteHome,
        hostUid,
        hostGid,
        syncedUid,
        syncedGid,
      },
      close,
    };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

export async function withOrchestratorSession<T>(
  action: (session: OrchestratorSession) => Promise<T>,
  sink?: AgentOutputSink,
  options: OrchestratorSessionOptions = {},
): Promise<T> {
  const active = await startOrchestratorSession(sink, options);
  try {
    return await action(active.session);
  } finally {
    await active.close();
  }
}
