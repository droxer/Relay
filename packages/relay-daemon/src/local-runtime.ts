import { join } from "node:path";
import { realpathSync, statSync } from "node:fs";
import { agentCredentialEnv, agentHomePath, allAgentCredentialEnvNames, getAgent, localRuntimeEnvironment, commandExecution, type AgentName } from "relay-core";
import type { DaemonExecutionEnvironment } from "./index.js";
import { superviseLocalProcess } from "./process-supervisor.js";
import { localExitProven, windowsExitProven } from "./exit-proof.js";
import { listWindowsProcesses } from "./windows-process-tree.js";
import { runNativeScript, nativeCommand } from "./native-command.js";
import { runBoundedPreflight } from "./agent-preflight.js";

/** Local CLI adapter. No registration, scheduling, or backend state lives here. */
export function createLocalRuntime(): DaemonExecutionEnvironment {
  // Readiness is a property of this host's agent installs, so it holds for
  // the daemon's lifetime: discovery (`ensureAgentReady` below, run at
  // startup, every refresh interval, and on `runtime.refresh`) probes afresh
  // and records the answer; a run trusts a recorded pass instead of spending
  // seconds on `claude auth status` or `codex login status` for every
  // message. A failed probe or a failed run forgets the agent again. This
  // mirrors the per-guest cache a BoxLite computer keeps (sandbox-session.ts).
  const readyAgents = new Set<AgentName>();
  const probe = async (agent: AgentName, signal?: AbortSignal): Promise<void> => {
    try {
      await ensureLocalAgentReady(agent, signal);
    } catch (error) {
      readyAgents.delete(agent);
      throw error;
    }
    readyAgents.add(agent);
  };
  return {
    sandboxMode: "none",
    ensureAgentReady: probe,
    execStream: localProcessExecStream,
    // Host processes share the machine; any number of runs can execute at once.
    acquireWorkspace: async (workspace, signal) => {
      const root = realpathSync.native(workspace);
      if (!statSync(root).isDirectory()) throw new Error("Local workspace scope must be a directory.");
      let released = false;
      const assertActive = (): void => {
        if (released) throw new Error("Local workspace lease has been released.");
        signal?.throwIfAborted();
        if (realpathSync.native(workspace) !== root) throw new Error("Local workspace scope changed.");
      };
      const execStream: DaemonExecutionEnvironment["execStream"] = async (cmd, args = [], options = {}) => {
        assertActive();
        if (options.cwd && realpathSync.native(options.cwd) !== root) throw new Error("Local workspace scope mismatch.");
        return localProcessExecStream(cmd, args, {
          ...options, cwd: root,
          signal: signal ? options.signal ? AbortSignal.any([signal, options.signal]) : signal : options.signal,
        });
      };
      return {
        ensureAgentReady: async (agent, signal) => {
          assertActive();
          if (readyAgents.has(agent)) {
            return;
          }
          await probe(agent, signal);
        },
        execStream,
        forgetAgentReady: (agent) => { readyAgents.delete(agent); },
        release: () => { released = true; },
      };
    },
    proveExited: async (records) => {
      if (process.platform !== "win32") return records.filter((record) => localExitProven(record)).map((record) => record.id);
      const processes = records.length ? await listWindowsProcesses() : undefined;
      return records.filter((record) => windowsExitProven(record, processes)).map((record) => record.id);
    },
    close: async () => undefined,
  };
}

export const localProcessExecStream: typeof superviseLocalProcess = async (cmd, args = [], options = {}) => {
  const selected = { ...options, env: { ...localAgentSubprocessEnv(), ...options.env } as Record<string, string> };
  if (cmd === "relay-native") return runNativeScript(args[0] ?? "", selected);
  if (process.platform === "win32" && (cmd === "node" || cmd === process.execPath) && ["-e", "--eval"].includes(args[0] ?? "")) {
    return runNativeScript(`await relayRun(${JSON.stringify([process.execPath, ...args])});`, selected);
  }
  try {
    const invocation = nativeCommand(cmd, args, selected.env);
    return await superviseLocalProcess(invocation.command, invocation.args, selected);
  } catch (error) {
    return { exit_code: typeof (error as { code?: unknown }).code === "number" ? (error as { code: number }).code : -1,
      stdout: "", stderr: "", error_message: (error as Error).message };
  }
};

async function ensureLocalAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void> {
  const def = getAgent(agent);
  const invocation = commandExecution(def.preflight.command());
  await runBoundedPreflight(agent, signal, (bounded) => localProcessExecStream(invocation.command, invocation.args, {
    signal: bounded,
    env: Object.fromEntries(agentCredentialEnv(agent)),
  }));
}

const AGENT_SUBPROCESS_ENV_DENY = new Set([
  "DATABASE_URL",
  "RELAY_CONTROL_PANEL_VERSION",
  "RELAY_DATABASE_URL",
  "RELAY_DATA_DIR",
  "RELAY_USER_ID",
  "RELAY_EMPLOYEE_ID", // pre-rename spelling, still set by older installs
  "RELAY_ENROLLMENT_TOKEN",
  "RELAY_SANDBOX_ID",
  "RELAY_SANDBOX_MODE",
  "RELAY_STORAGE",
  "RELAY_USE_LOCAL_AGENT_HOME",
  "RELAY_WEB_UI_DIST_DIR",
]);

const AGENT_SUBPROCESS_ENV_DENY_PREFIXES = [
  "RELAY_ADMIN_",
  "RELAY_AUTH_",
  "RELAY_BACKEND_",
  "RELAY_CHAT_",
  "RELAY_DAEMON_",
  "RELAY_SUPERVISOR_",
  "RELAY_TASK_SCHEDULER_",
];

function localAgentSubprocessEnv(): NodeJS.ProcessEnv {
  const env = localRuntimeEnvironment();
  for (const key of Object.keys(env)) {
    if (isDeniedAgentSubprocessEnv(key)) {
      delete env[key];
    }
  }
  // A local node runs agents as child processes of the daemon, so anything in
  // the daemon's own environment is inherited. Provider credentials must not
  // ride along: the caller layers the running agent's own keys back on top, and
  // inheriting the rest would hand every agent every provider's key — exactly
  // the leak the BoxLite guest avoids by never holding credentials at all.
  for (const key of allAgentCredentialEnvNames()) delete env[key];
  const home = agentHomePath();
  env.HOME = home;
  env.CODEX_HOME ??= join(home, ".codex");
  env.PI_CODING_AGENT_DIR ??= join(home, ".pi", "agent");
  return env;
}

function isDeniedAgentSubprocessEnv(key: string): boolean {
  return AGENT_SUBPROCESS_ENV_DENY.has(key)
    || AGENT_SUBPROCESS_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
