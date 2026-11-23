// Resolves how a runtime reaches the run's permission broker. Each adapter is
// a compiled script beside this module, run with the daemon's own node —
// except Pi's, which `pi` itself loads with `--extension`.
import { fileURLToPath } from "node:url";
import type { PermissionPromptAdapter, PermissionPromptLaunch } from "relay-core";
import { stageAntigravityAcp } from "./antigravity-guest.js";

const ADAPTER_SCRIPTS: Record<PermissionPromptAdapter, string> = {
  "claude-mcp": "./claude-mcp.js",
  "codex-app-server": "./codex-app-server.js",
  "opencode-acp": "./opencode-acp.js",
  "antigravity-acp": "./antigravity-acp.js",
  "pi-extension": "./pi-extension.js",
};

/** The compiled script for one adapter, in dist beside this module. */
export function permissionAdapterScript(adapter: PermissionPromptAdapter): string {
  return fileURLToPath(new URL(ADAPTER_SCRIPTS[adapter], import.meta.url));
}

/** Claude reads its prompt once; this launcher holds its input open for live messages. */
const CLAUDE_LIVE_LAUNCHER = "./claude-stream.js";

export function permissionAdapterLaunch(
  adapter: PermissionPromptAdapter,
  broker: { readonly env: Record<string, string> },
): PermissionPromptLaunch {
  const launch = { adapter, command: process.execPath, args: [permissionAdapterScript(adapter)], env: { ...broker.env } };
  return adapter === "claude-mcp"
    ? { ...launch, liveLauncher: { command: process.execPath, args: [fileURLToPath(new URL(CLAUDE_LIVE_LAUNCHER, import.meta.url))] } }
    : launch;
}

const GUEST_ADAPTER_STAGERS: Partial<Record<PermissionPromptAdapter, typeof stageAntigravityAcp>> = {
  "antigravity-acp": stageAntigravityAcp,
};

export function stageGuestPermissionAdapter(
  adapter: PermissionPromptAdapter, ...args: Parameters<typeof stageAntigravityAcp>
) {
  const stage = GUEST_ADAPTER_STAGERS[adapter];
  if (!stage) throw new Error(`Relay cannot stage the ${adapter} adapter in a guest.`);
  return stage(...args);
}
