import { join } from "node:path";
import { agentCredentialEnv, agentHomePath, allAgentCredentialEnvNames, getAgent, localRuntimeEnvironment, type AgentName } from "relay-core";
import type { DaemonExecutionEnvironment } from "./index.js";
import { assertKimiConfigured } from "./agent-auth.js";
import { superviseLocalProcess } from "./process-supervisor.js";
import { localExitProven, windowsExitProven } from "./exit-proof.js";
import { listWindowsProcesses } from "./windows-process-tree.js";
import { localBash } from "./local-shell.js";

/** Local CLI adapter. No registration, scheduling, or backend state lives here. */
export function createLocalRuntime(): DaemonExecutionEnvironment {
  return {
    sandboxMode: "none",
    ensureAgentReady: ensureLocalAgentReady,
    execStream: localProcessExecStream,
    // Host processes share the machine; any number of runs can execute at once.
    acquireWorkspace: async () => ({
      ensureAgentReady: ensureLocalAgentReady,
      execStream: localProcessExecStream,
      release: () => undefined,
    }),
    proveExited: async (records) => {
      if (process.platform !== "win32") return records.filter((record) => localExitProven(record)).map((record) => record.id);
      const processes = records.length ? await listWindowsProcesses() : undefined;
      return records.filter((record) => windowsExitProven(record, processes)).map((record) => record.id);
    },
    close: async () => undefined,
  };
}

export const localProcessExecStream: typeof superviseLocalProcess = async (cmd, args = [], options = {}) => {
  let program = cmd;
  // Agent scripts are written for bash; on Windows that is Git Bash, never WSL.
  try { if (cmd === "bash") program = localBash(); }
  catch (error) { return { exit_code: -1, stdout: "", stderr: "", error_message: (error as Error).message }; }
  return superviseLocalProcess(program, args, { ...options, env: { ...localAgentSubprocessEnv(), ...options.env } as Record<string, string> });
};

async function ensureLocalAgentReady(agent: AgentName, signal?: AbortSignal): Promise<void> {
  const def = getAgent(agent);
  if (agent === "kimi") {
    const env = localRuntimeEnvironment();
    assertKimiConfigured(env.KIMI_CODE_HOME || join(agentHomePath(), ".kimi-code"), { native: true });
  }
  const result = await localProcessExecStream("bash", ["-c", def.preflight.command()], {
    signal,
    env: Object.fromEntries(agentCredentialEnv(agent)),
  });
  if (result.exit_code !== 0) {
    const detail = (result.stderr || result.stdout || result.error_message || "").trim();
    throw new Error(`${def.preflight.label} preflight failed.${detail ? ` ${detail}` : ""}`);
  }
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
  env.KIMI_CODE_HOME ??= join(home, ".kimi-code");
  return env;
}

function isDeniedAgentSubprocessEnv(key: string): boolean {
  return AGENT_SUBPROCESS_ENV_DENY.has(key)
    || AGENT_SUBPROCESS_ENV_DENY_PREFIXES.some((prefix) => key.startsWith(prefix));
}
