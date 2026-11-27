import { isLocalAgentExecution, isResumableSessionId, runAsAgent, shellCommand } from "relay-core";
import type { DaemonSandboxMode, WorkspaceExecution } from "./index.js";

export async function importCodexGeneratedImages(
  exec: WorkspaceExecution["execStream"],
  options: {
    sandboxMode: DaemonSandboxMode;
    workspacePath: string;
    codexSkillHome?: string;
    sessionId: string;
    destination: string;
    startedAt: number;
    signal?: AbortSignal;
  },
): Promise<void> {
  // A runtime ID is a single directory name; never read paths from agent text.
  if (!isResumableSessionId(options.sessionId)) return;
  const { workspacePath, sandboxMode, codexSkillHome, signal } = options;
  const guest = sandboxMode === "boxlite";
  const argv = [
    guest ? "node" : process.execPath,
    "-e", `(${copyImages.toString()})().catch(() => { process.exitCode = 1; });`,
    options.sessionId, options.destination, String(options.startedAt),
    ...(guest && !isLocalAgentExecution() && codexSkillHome ? [codexSkillHome] : []),
  ];
  const result = guest
    ? await exec("bash", ["-c", runAsAgent(shellCommand(argv), workspacePath)], { signal })
    : await exec(argv[0], argv.slice(1), { cwd: workspacePath, signal });
  if (result.exit_code !== 0) throw new Error("Codex image import failed");
}

// Executed with Node in the same environment as Codex. BoxLite's runtime home
// is inside the guest, but its workspace is mounted for the normal host scan.
async function copyImages(): Promise<void> {
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const { constants } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const { homedir } = require("node:os") as typeof import("node:os");
  const { randomUUID } = require("node:crypto") as typeof import("node:crypto");
  const { pipeline } = require("node:stream/promises") as typeof import("node:stream/promises");
  const [, sessionId, destination, startedAt, skillHome] = process.argv;
  const directory = async (path: string) => {
    try { return (await fs.lstat(path)).isDirectory(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  };
  const home = process.env.CODEX_HOME ?? join(homedir(), ".codex");
  const defaultGenerated = join(home, "generated_images");
  let generated = skillHome ? join(skillHome, "generated_images") : defaultGenerated;
  if (!(await directory(generated))) {
    // Managed skill views link existing entries from the default Codex home.
    // Accept that specific link and keep the session directory itself real.
    if (!skillHome || !(await directory(defaultGenerated))
      || await fs.realpath(generated).catch(() => undefined) !== await fs.realpath(defaultGenerated)) return;
    generated = defaultGenerated;
  }
  const source = join(generated, sessionId);
  if (!(await directory(source))) return;

  for await (const entry of await fs.opendir(source)) {
    if (!entry.isFile() || !/^[a-z0-9_-]+\.(png|gif)$/i.test(entry.name)) continue;
    const input = await fs.open(join(source, entry.name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT" && error.code !== "ELOOP") throw error;
      });
    if (!input) continue;
    try {
      const stat = await input.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.mtimeMs < Number(startedAt)) continue;
      const header = Buffer.alloc(8);
      const { bytesRead } = await input.read(header, 0, header.length, 0);
      if (bytesRead < header.length) continue;
      const valid = entry.name.toLowerCase().endsWith(".png")
        ? header.toString("hex") === "89504e470d0a1a0a"
        : /^GIF8[79]a$/.test(header.toString("ascii", 0, 6));
      if (!valid) continue;

      let outputDir = process.cwd();
      for (const part of destination.split("/")) {
        outputDir = join(outputDir, part);
        await fs.mkdir(outputDir).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
        if (!(await directory(outputDir))) return;
      }
      const outputPath = join(outputDir, entry.name);
      // Publish the complete file in one step and keep a destination the
      // agent already wrote. The snapshot walk ignores unfinished copies.
      const temporary = join(outputDir, `~$relay-${randomUUID()}`);
      const output = await fs.open(temporary, "wx");
      try {
        await pipeline(input.createReadStream({ start: 0, end: stat.size - 1, autoClose: false }), output.createWriteStream());
        await fs.link(temporary, outputPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      } finally {
        await fs.unlink(temporary);
      }
    } finally {
      await input.close();
    }
  }
}
