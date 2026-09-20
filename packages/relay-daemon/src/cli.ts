#!/usr/bin/env node
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { applyLocalRuntimeEnvironment, loadPackageEnv } from "relay-core";
import { resolveSandboxMode, runRelayDaemon, runRelayDaemonDoctor } from "./index.js";

import { loadRuntimeProfile } from "./runtime-profile.js";

loadPackageEnv("relay-daemon");

function showHelp(): void {
  console.log(`relay-daemon [options]

Options:
  --backend-url <url>   Relay backend URL (also RELAY_BACKEND_URL).
  --sandbox-id <id>     Sandbox identifier (required; also RELAY_SANDBOX_ID).
  --employee-id <id>    Employee identifier (also RELAY_EMPLOYEE_ID).
  --token <token>       Daemon node token (also RELAY_DAEMON_NODE_TOKEN).
  --enrollment-token <token>
                        One-time managed-node enrollment token (also
                        RELAY_ENROLLMENT_TOKEN). Replaces --sandbox-id and
                        --token for the first start.
  --workspace <path>    Employee-selected or supervisor-provisioned workspace
                        root; Relay creates <path>/<thread-id> per thread
                        (also RELAY_WORKSPACE or WORKSPACE).
  --workspace-id <id>   Stable workspace identity for continuity and drift
                        detection on this daemon node
                        (also RELAY_WORKSPACE_ID).
  --sandbox <mode>      Sandbox mode: "boxlite" boots a BoxLite VM and runs
                        agents inside it; "none" runs agents as local
                        processes (default: boxlite; also RELAY_SANDBOX_MODE).
  --use-local-agent-home
                        Deprecated compatibility flag. Local mode uses this
                        user's HOME for existing agent auth and config by default.
  --allow-host-agent-execution
                        Explicitly allow sandbox "none" to run model-generated
                        commands with this user's host permissions (also
                        RELAY_ALLOW_HOST_AGENT_EXECUTION=1).
  --local-permission-policy <native|trusted>
                        Local CLI permissions (default: native). Trusted bypasses
                        runtime approvals. Also RELAY_LOCAL_PERMISSION_POLICY.
  --runtime-profile <path>
                        Private local runtime settings and credential-file reference.
  --doctor              Read-only backend/token check plus local agent preflight,
                        then exit without running the daemon loop.
  --help                Show this help message.
  --version             Show version information.
`);
}

function showVersion(): void {
  console.log("relay-daemon 0.1.0");
}

export interface DaemonCliArgs {
  backendUrl?: string;
  sandboxId?: string;
  employeeId?: string;
  token?: string;
  enrollmentToken?: string;
  workspace?: string;
  workspaceId?: string;
  sandbox?: string;
  localPermissionPolicy?: "native" | "trusted";
  runtimeProfile?: string;
  useLocalAgentHome: boolean;
  allowHostAgentExecution: boolean;
  doctor: boolean;
  help: boolean;
  version: boolean;
}

export function resolveAllowHostAgentExecution(args: DaemonCliArgs): boolean {
  return args.allowHostAgentExecution || process.env.RELAY_ALLOW_HOST_AGENT_EXECUTION === "1";
}

export function parseArgs(argv: string[]): DaemonCliArgs {
  let backendUrl: string | undefined;
  let sandboxId: string | undefined;
  let employeeId: string | undefined;
  let token: string | undefined;
  let enrollmentToken: string | undefined;
  let workspace: string | undefined;
  let workspaceId: string | undefined;
  let sandbox: string | undefined;
  let localPermissionPolicy: "native" | "trusted" | undefined;
  let runtimeProfile: string | undefined;
  let useLocalAgentHome = false;
  let allowHostAgentExecution = false;
  let doctor = false;
  let help = false;
  let version = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      help = true;
    } else if (arg === "--version") {
      version = true;
    } else if (arg === "--doctor") {
      doctor = true;
    } else if (arg === "--use-local-agent-home") {
      useLocalAgentHome = true;
    } else if (arg === "--allow-host-agent-execution") {
      allowHostAgentExecution = true;
    } else if (arg === "--local-permission-policy") {
      const value = argv[++i];
      if (value !== "native" && value !== "trusted") throw new Error("Local permission policy must be native or trusted.");
      localPermissionPolicy = value;
    } else if (arg === "--runtime-profile") {
      const value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error("--runtime-profile requires a path.");
      runtimeProfile = value;
    } else if (arg === "--backend-url") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--backend-url requires a value.");
      }
      backendUrl = value;
      i += 1;
    } else if (arg === "--sandbox-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--sandbox-id requires a value.");
      }
      sandboxId = value;
      i += 1;
    } else if (arg === "--employee-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--employee-id requires a value.");
      }
      employeeId = value;
      i += 1;
    } else if (arg === "--token") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--token requires a value.");
      }
      token = value;
      i += 1;
    } else if (arg === "--enrollment-token") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--enrollment-token requires a value.");
      }
      enrollmentToken = value;
      i += 1;
    } else if (arg === "--workspace") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--workspace requires a value.");
      }
      workspace = value;
      i += 1;
    } else if (arg === "--workspace-id") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--workspace-id requires a value.");
      }
      workspaceId = value;
      i += 1;
    } else if (arg === "--sandbox") {
      const value = argv[i + 1];
      if (!value || value.startsWith("-")) {
        throw new Error("--sandbox requires a value (boxlite or none).");
      }
      sandbox = value;
      i += 1;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return {
    backendUrl,
    sandboxId,
    employeeId,
    token,
    ...(enrollmentToken ? { enrollmentToken } : {}),
    workspace,
    workspaceId,
    sandbox,
    ...(localPermissionPolicy ? { localPermissionPolicy } : {}),
    ...(runtimeProfile ? { runtimeProfile } : {}),
    useLocalAgentHome,
    allowHostAgentExecution,
    doctor,
    help,
    version,
  };
}

export async function main(argv: string[] = process.argv): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    showHelp();
    return;
  }

  if (args.version) {
    showVersion();
    return;
  }

  if (args.runtimeProfile) applyLocalRuntimeEnvironment(loadRuntimeProfile(args.runtimeProfile));
  const policy = args.localPermissionPolicy ?? process.env.RELAY_LOCAL_PERMISSION_POLICY ?? "native";
  if (policy !== "native" && policy !== "trusted") throw new Error("Local permission policy must be native or trusted.");
  process.env.RELAY_LOCAL_PERMISSION_POLICY = policy;

  const sandboxId = args.sandboxId ?? process.env.RELAY_SANDBOX_ID;
  const enrollmentToken = args.enrollmentToken ?? process.env.RELAY_ENROLLMENT_TOKEN;
  if (!sandboxId && !enrollmentToken) {
    console.error("Error: --sandbox-id/RELAY_SANDBOX_ID or --enrollment-token/RELAY_ENROLLMENT_TOKEN is required.");
    showHelp();
    process.exitCode = 1;
    return;
  }
  const workspacePath = args.workspace ?? process.env.RELAY_WORKSPACE ?? process.env.WORKSPACE;
  if (!workspacePath) {
    console.error("Error: --workspace/RELAY_WORKSPACE is required and must point to the workspace root selected during setup.");
    showHelp();
    process.exitCode = 1;
    return;
  }
  if (args.doctor) {
    if (!sandboxId) {
      console.error("Error: --doctor requires an enrolled --sandbox-id.");
      process.exitCode = 1;
      return;
    }
    const report = await runRelayDaemonDoctor({
      backendUrl: args.backendUrl ?? process.env.RELAY_BACKEND_URL,
      sandboxId,
      employeeId: args.employeeId ?? process.env.RELAY_EMPLOYEE_ID,
      token: args.token ?? process.env.RELAY_DAEMON_NODE_TOKEN ?? process.env.RELAY_DAEMON_TOKEN,
      workspacePath,
      workspaceId: args.workspaceId ?? process.env.RELAY_WORKSPACE_ID,
      sandbox: resolveSandboxMode(args.sandbox ?? process.env.RELAY_SANDBOX_MODE),
      allowHostAgentExecution: resolveAllowHostAgentExecution(args),
      agentHome: args.useLocalAgentHome ? homedir() : undefined,
    });
    for (const check of report.checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }
  await runRelayDaemon({
    backendUrl: args.backendUrl ?? process.env.RELAY_BACKEND_URL,
    sandboxId,
    employeeId: args.employeeId ?? process.env.RELAY_EMPLOYEE_ID,
    token: args.token ?? process.env.RELAY_DAEMON_NODE_TOKEN ?? process.env.RELAY_DAEMON_TOKEN,
    enrollmentToken,
    workspacePath,
    workspaceId: args.workspaceId ?? process.env.RELAY_WORKSPACE_ID,
    sandbox: resolveSandboxMode(args.sandbox ?? process.env.RELAY_SANDBOX_MODE),
    allowHostAgentExecution: resolveAllowHostAgentExecution(args),
    agentHome: args.useLocalAgentHome ? homedir() : undefined,
  });
}

export function isMainModule(moduleUrl: string, argvPath: string | undefined): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
  }
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
