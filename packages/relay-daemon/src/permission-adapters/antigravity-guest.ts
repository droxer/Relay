import { readFile } from "node:fs/promises";
import { commandExecution, runAsAgent, shellCommand, type PermissionPromptLaunch } from "relay-core";
import type { WorkspaceExecution } from "../index.js";

const ENTRY = "antigravity-acp.js";
const MODULES = [ENTRY, "acp-connection.js", "acp-session-updates.js", "protocol.js"];
const STAGE = `
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { join } = require("node:path");
const root = mkdtempSync("/tmp/relay-agy-acp-");
try {
  writeFileSync(join(root, "package.json"), '{"type":"module"}');
  for (const [name, source] of JSON.parse(process.argv[1])) {
    writeFileSync(join(root, name), source);
  }
  process.stdout.write(root);
} catch (error) {
  rmSync(root, { recursive: true, force: true });
  throw error;
}
`;

/** Stage the daemon's own ACP adapter in a guest without exposing host paths. */
export async function stageAntigravityAcp(
  execution: Pick<WorkspaceExecution, "execStream">, cwd: string, signal?: AbortSignal,
): Promise<{ launch: PermissionPromptLaunch; dispose(): Promise<void> }> {
  const files = await Promise.all(MODULES.map(async (name) => [
    name, await readFile(new URL(name, import.meta.url), "utf8"),
  ]));
  const invocation = commandExecution(runAsAgent(shellCommand(["node", "-e", STAGE, JSON.stringify(files)]), cwd));
  const staged = await execution.execStream(invocation.command, invocation.args, { signal, sink: () => undefined });
  const root = staged.stdout.trim();
  if (staged.exit_code !== 0 || !/^\/tmp\/relay-agy-acp-[A-Za-z0-9]+$/.test(root)) {
    throw new Error(`Could not stage Antigravity ACP in the guest: ${staged.error_message || staged.stderr.trim() || "invalid staging result"}`);
  }
  return {
    launch: { adapter: "antigravity-acp", command: "node", args: [`${root}/${ENTRY}`], env: {} },
    async dispose() {
      const removal = commandExecution(runAsAgent(shellCommand(["rm", "-rf", "--", root]), cwd));
      await execution.execStream(removal.command, removal.args, { signal: AbortSignal.timeout(5_000), sink: () => undefined })
        .catch(() => undefined); // The whole directory also goes away with the guest.
    },
  };
}
