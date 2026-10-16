#!/usr/bin/env node
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadPackageEnv } from "relay-core";
import { SupervisorBackendClient } from "./backend-client.js";
import { CommandTemplateLauncher, LocalDaemonLauncher, workspaceForUser, workspaceForManagedNode } from "./launchers.js";
import { ManagedNodeReconciler } from "./managed-reconcile.js";
import { LocalProcessProvider } from "./providers.js";
import { RelaySupervisor } from "./reconcile.js";
import type { DaemonLauncher, UserRecord, SupervisorLogger } from "./types.js";

loadPackageEnv("relay-supervisor");

interface SupervisorCliArgs {
  backendUrl?: string;
  adminToken?: string;
  workspaceRoot?: string;
  provider?: string;
  sandbox?: "none" | "boxlite";
  command?: string;
  intervalMs?: number;
  once: boolean;
  help: boolean;
  version: boolean;
}

const consoleLogger: SupervisorLogger = {
  info(message, fields) {
    console.log(formatLog("INFO", message, fields));
  },
  warn(message, fields) {
    console.warn(formatLog("WARN", message, fields));
  },
  error(message, fields) {
    console.error(formatLog("ERROR", message, fields));
  },
};

function showHelp(): void {
  console.log(`relay-supervisor [options]

Options:
  --backend-url <url>       Relay backend URL (also RELAY_BACKEND_URL).
  --admin-token <token>     Admin bearer token (also RELAY_ADMIN_TOKEN).
  --workspace-root <path>   Root for managed computer workspace roots; each
                            daemon creates one child directory per thread.
  --provider <name>         "local" or "command" (default: local).
  --sandbox <mode>          Local provider sandbox mode: "none" or "boxlite"
                            (default: boxlite).
  --command <template>      Command provider template.
  --interval-ms <ms>        Reconcile interval (default: 10000).
  --once                    Run one reconcile pass and exit.
  --help                    Show this help message.
  --version                 Show version information.

Command templates can use:
  {{userId}} {{sandboxId}} {{nodeToken}} {{workspacePath}} {{backendUrl}}

Example for a remote workstation provider:
  relay-supervisor --provider command --command "gcloud workstations ssh relay-{{userId}} --start-workstation --command 'relay-daemon --backend-url {{backendUrl}} --sandbox-id {{sandboxId}} --user-id {{userId}} --token {{nodeToken}} --sandbox none --allow-host-agent-execution'"
`);
}

function showVersion(): void {
  console.log("relay-supervisor 0.1.0");
}

export function parseArgs(argv: string[]): SupervisorCliArgs {
  const args: SupervisorCliArgs = { once: false, help: false, version: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help") {
      args.help = true;
    } else if (arg === "--version") {
      args.version = true;
    } else if (arg === "--once") {
      args.once = true;
    } else if (arg === "--backend-url") {
      args.backendUrl = requiredValue(argv, ++i, arg);
    } else if (arg === "--admin-token") {
      args.adminToken = requiredValue(argv, ++i, arg);
    } else if (arg === "--workspace-root") {
      args.workspaceRoot = requiredValue(argv, ++i, arg);
    } else if (arg === "--provider") {
      args.provider = requiredValue(argv, ++i, arg);
    } else if (arg === "--sandbox") {
      const value = requiredValue(argv, ++i, arg);
      if (value !== "none" && value !== "boxlite") throw new Error("--sandbox must be none or boxlite.");
      args.sandbox = value;
    } else if (arg === "--command") {
      args.command = requiredValue(argv, ++i, arg);
    } else if (arg === "--interval-ms") {
      const value = Number(requiredValue(argv, ++i, arg));
      if (!Number.isFinite(value) || value <= 0) throw new Error("--interval-ms must be a positive number.");
      args.intervalMs = value;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
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

  const backendUrl = args.backendUrl ?? process.env.RELAY_BACKEND_URL ?? "http://127.0.0.1:8790";
  const workspaceRoot = args.workspaceRoot ?? process.env.RELAY_SUPERVISOR_WORKSPACE_ROOT ?? defaultWorkspaceRoot();
  const backend = new SupervisorBackendClient({
    backendUrl,
    adminToken: args.adminToken ?? process.env.RELAY_ADMIN_TOKEN,
  });
  const useLegacyUserScan = (args.provider ?? process.env.RELAY_SUPERVISOR_PROVIDER) === "command";
  const supervisor = useLegacyUserScan
    ? new RelaySupervisor({
        backend,
        launcher: buildLauncher(args, backendUrl, workspaceRoot),
        workspacePathForUser: (user: UserRecord) => workspaceForUser(workspaceRoot, user.id),
        logger: consoleLogger,
      })
    : new ManagedNodeReconciler({
        backend,
        providers: [new LocalProcessProvider({ logger: consoleLogger })],
        backendUrl,
        workspacePathForNode: (node) => workspaceForManagedNode(workspaceRoot, node.id),
        logger: consoleLogger,
      });

  const stop = async () => {
    await supervisor.stop();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());

  if (args.once) {
    consoleLogger.info("supervisor reconcile", { ...await supervisor.reconcileOnce() });
    await supervisor.stop();
    return;
  }

  const intervalMs = args.intervalMs ?? 10_000;
  while (true) {
    try {
      consoleLogger.info("supervisor reconcile", { ...await supervisor.reconcileOnce() });
    } catch (error) {
      consoleLogger.error("supervisor reconcile failed", { error: error instanceof Error ? error.message : String(error) });
    }
    await delay(intervalMs);
  }
}

function buildLauncher(args: SupervisorCliArgs, backendUrl: string, workspaceRoot: string): DaemonLauncher {
  const provider = args.provider ?? process.env.RELAY_SUPERVISOR_PROVIDER ?? "local";
  if (provider === "local") {
    return new LocalDaemonLauncher({
      backendUrl,
      workspaceRoot,
      sandboxMode: args.sandbox ?? sandboxModeFromEnv(),
      logger: consoleLogger,
    });
  }
  if (provider === "command") {
    const command = args.command ?? process.env.RELAY_SUPERVISOR_COMMAND;
    if (!command) throw new Error("--command or RELAY_SUPERVISOR_COMMAND is required when --provider command is used.");
    return new CommandTemplateLauncher({ command, logger: consoleLogger });
  }
  throw new Error(`Unsupported supervisor provider: ${provider}`);
}

function sandboxModeFromEnv(): "none" | "boxlite" {
  const value = process.env.RELAY_SANDBOX_MODE;
  return value === "none" ? "none" : "boxlite";
}

function requiredValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${flag} requires a value.`);
  return value;
}

function formatLog(level: string, message: string, fields?: Record<string, unknown>): string {
  return `${new Date().toISOString()} ${level} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const WORKSPACE_ROOT = ".relay/user-workspaces";
const LEGACY_WORKSPACE_ROOT = ".relay/employee-workspaces";

/** Keep using the pre-rename default when it holds a deployment's workspaces. */
export function defaultWorkspaceRoot(exists: (path: string) => boolean = existsSync): string {
  return exists(LEGACY_WORKSPACE_ROOT) && !exists(WORKSPACE_ROOT) ? LEGACY_WORKSPACE_ROOT : WORKSPACE_ROOT;
}

// Last, so every module-level binding above is initialized before main() reads it.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
