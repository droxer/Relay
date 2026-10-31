// Resolves how a runtime reaches the run's permission broker. Each adapter is
// a compiled script beside this module, run with the daemon's own node —
// except Pi's, which `pi` itself loads with `--extension`.
import { fileURLToPath } from "node:url";
import type { PermissionPromptAdapter, PermissionPromptLaunch } from "relay-core";

const ADAPTER_SCRIPTS: Record<PermissionPromptAdapter, string> = {
  "claude-mcp": "./claude-mcp.js",
  "codex-app-server": "./codex-app-server.js",
  "kimi-acp": "./kimi-acp.js",
  "opencode-acp": "./opencode-acp.js",
  "pi-extension": "./pi-extension.js",
};

/** The compiled script for one adapter, in dist beside this module. */
export function permissionAdapterScript(adapter: PermissionPromptAdapter): string {
  return fileURLToPath(new URL(ADAPTER_SCRIPTS[adapter], import.meta.url));
}

export function permissionAdapterLaunch(
  adapter: PermissionPromptAdapter,
  broker: { readonly env: Record<string, string> },
): PermissionPromptLaunch {
  return { adapter, command: process.execPath, args: [permissionAdapterScript(adapter)], env: { ...broker.env } };
}
