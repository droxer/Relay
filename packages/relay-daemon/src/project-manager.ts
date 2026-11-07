/** Run-scoped file transport shared by every runtime and both sandbox modes. */
import { constants, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { listWorkspace, readWorkspaceFile } from "./workspace-read.js";

type Arguments = Record<string, unknown>;
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_IN_FLIGHT = 8;

// Paths are relative to this script, so the same helper works on the host and
// inside a guest whose mount path differs. No backend credential enters it.
const HELPER_SOURCE = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dir = __dirname;
const id = crypto.randomUUID();
async function main() {
  if (fs.existsSync(path.join(dir, 'closed'))) throw new Error('Manager run ended.');
  const tool = process.argv[2];
  const args = JSON.parse(process.argv[3] || '{}');
  if (!tool || !args || Array.isArray(args) || typeof args !== 'object') throw new Error('Usage: node tool.cjs <tool> <JSON object>');
  const request = JSON.stringify({tool, arguments: args});
  if (Buffer.byteLength(request) > 131072) throw new Error('Request too large.');
  const temporary = path.join(dir, id + '.tmp');
  fs.writeFileSync(temporary, request, {flag: 'wx', mode: 0o600});
  fs.renameSync(temporary, path.join(dir, id + '.request'));
  const response = path.join(dir, id + '.response');
  const deadline = Date.now() + 90000;
  while (!fs.existsSync(response)) {
    if (Date.now() > deadline || fs.existsSync(path.join(dir, 'closed'))) throw new Error('Manager tool unavailable; retry in an active run.');
    await new Promise(resolve => setTimeout(resolve, 75));
  }
  const result = JSON.parse(fs.readFileSync(response, 'utf8'));
  fs.unlinkSync(response);
  if (result.error) throw new Error(result.error);
  process.stdout.write(JSON.stringify(result.result) + '\n');
}
main().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
`;

export function createProjectManagerBridge(
  workspace: string,
  invoke: (tool: string, args: Arguments) => Promise<unknown>,
): { toolPath: string; toolCommand: string; dispose: () => Promise<void> } {
  const root = realpathSync(workspace);
  const control = join(root, ".relay");
  if (!existsSync(control)) mkdirSync(control, { mode: 0o700 });
  if (lstatSync(control).isSymbolicLink() || !lstatSync(control).isDirectory()) throw new Error("Unsafe manager control directory.");
  const dir = mkdtempSync(join(control, "manager-"));
  const identity = lstatSync(dir);
  const safeDirectory = () => {
    const current = lstatSync(dir);
    if (current.isSymbolicLink() || current.ino !== identity.ino || realpathSync(dir) !== dir) throw new Error("Manager control directory changed.");
  };
  writeFileSync(join(dir, "tool.cjs"), HELPER_SOURCE, { mode: 0o600, flag: "wx" });
  let closed = false;
  const pending = new Set<Promise<void>>();
  // Only outstanding names need tracking: requests are removed after their
  // response is published. A run has no lifetime tool-call limit.
  const processing = new Set<string>();
  async function handle(name: string): Promise<void> {
    if (closed) return;
    processing.add(name);
    const request = join(dir, name);
    let result: unknown;
    let error: string | undefined;
    try {
      safeDirectory();
      if (lstatSync(request).isSymbolicLink()) throw new Error("Invalid manager request.");
      const fd = openSync(request, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      let raw: string;
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.size > MAX_REQUEST_BYTES) throw new Error("Invalid manager request.");
        const buffer = Buffer.alloc(MAX_REQUEST_BYTES + 1);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        if (bytes > MAX_REQUEST_BYTES) throw new Error("Manager request too large.");
        raw = buffer.subarray(0, bytes).toString("utf8");
      } finally { closeSync(fd); }
      const body = JSON.parse(raw) as { tool?: unknown; arguments?: unknown };
      if (typeof body.tool !== "string" || !body.arguments || typeof body.arguments !== "object" || Array.isArray(body.arguments)) throw new Error("Invalid manager tool arguments.");
      result = await invoke(body.tool, body.arguments as Arguments);
      if (Buffer.byteLength(JSON.stringify(result) ?? "null") > MAX_RESPONSE_BYTES) throw new Error("Tool result too large; narrow the query.");
    } catch (cause) { error = cause instanceof Error ? cause.message : "Manager tool failed."; }
    if (closed) return;
    safeDirectory();
    const temporary = join(dir, name.replace(/\.request$/, ".response.tmp"));
    writeFileSync(temporary, JSON.stringify(error ? { error } : { result }), { flag: "wx", mode: 0o600 });
    // Another process may poll as soon as the response name exists. Publish
    // that name only after all bytes have been written and the file closed.
    renameSync(temporary, join(dir, name.replace(/\.request$/, ".response")));
    unlinkSync(request);
  }
  const timer = setInterval(() => {
    if (closed || pending.size >= MAX_IN_FLIGHT) return;
    try {
      safeDirectory();
      const names = readdirSync(dir)
        .filter(name => /^[a-f0-9-]{36}\.request$/.test(name) && !processing.has(name))
        .slice(0, MAX_IN_FLIGHT - pending.size);
      for (const name of names) {
        const task = handle(name).catch(() => { closed = true; clearInterval(timer); });
        pending.add(task);
        void task.finally(() => { pending.delete(task); processing.delete(name); });
      }
    } catch { closed = true; clearInterval(timer); }
  }, 75);
  const toolPath = relative(root, join(dir, "tool.cjs")).split(sep).join("/");
  return {
    toolPath, toolCommand: `node "${toolPath}"`,
    async dispose() {
      clearInterval(timer);
      closed = true;
      await Promise.all(pending);
      // Never recursively delete agent-controlled directories on the host.
      safeDirectory();
      if (!existsSync(join(dir, "closed"))) writeFileSync(join(dir, "closed"), "", { flag: "wx", mode: 0o600 });
    },
  };
}

export function managerWorkspaceTool(workspace: string, tool: string, args: Arguments): Record<string, unknown> {
  const path = typeof args.path === "string" ? args.path : "";
  if (path.split(/[\\/]/).some(part => part === ".relay" || part === ".git")) throw new Error("Control files are not project information.");
  if (tool === "files") {
    const listing = listWorkspace(workspace, path);
    const limit = args.limit ?? 100;
    const cursor = args.cursor ?? "";
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100 || typeof cursor !== "string") throw new Error("Invalid pagination.");
    const entries = listing.entries.filter(e => ![".relay", ".git"].includes(e.name)).sort((a,b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const remaining = entries.filter(e => e.name > cursor);
    const page = remaining.slice(0, limit);
    return {...listing, entries:page, total:entries.length, nextCursor:remaining.length > limit ? page.at(-1)!.name : null};
  }
  if (tool === "file") {
    const read = readWorkspaceFile(workspace, path, 64 * 1024);
    return { ...read, contentBase64: undefined, content: read.contentBase64 ? Buffer.from(read.contentBase64, "base64").toString("utf8") : null };
  }
  if (tool !== "search" || typeof args.query !== "string" || !args.query.trim() || args.query.length > 200) throw new Error("Use files, file, or search with a nonempty query.");
  const queue = [path];
  const matches: Array<{ path: string; line: number; text: string }> = [];
  let scanned = 0;
  let directories = 0;
  while (queue.length && scanned < 500 && directories++ < 100 && matches.length < 50) {
    const directory = queue.shift()!;
    for (const entry of listWorkspace(workspace, directory).entries.slice(0, 1000)) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "out"].includes(entry.name)) continue;
      const entryPath = directory ? `${directory}/${entry.name}` : entry.name;
      if (entry.kind === "directory") { if(queue.length < 1000) queue.push(entryPath); continue; }
      if (entry.kind !== "file" || scanned++ >= 500) continue;
      try {
        const read = readWorkspaceFile(workspace, entryPath, 64 * 1024);
        if (read.isBinary || !read.contentBase64) continue;
        const lines = Buffer.from(read.contentBase64, "base64").toString("utf8").split("\n");
        for (let line = 0; line < lines.length && matches.length < 50; line++) {
          if (lines[line].toLocaleLowerCase().includes(args.query.toLocaleLowerCase())) matches.push({ path: entryPath, line: line + 1, text: lines[line].slice(0, 500) });
        }
      } catch { /* A disappeared or inaccessible file is not a match. */ }
    }
  }
  return { matches, scannedFiles: scanned, coverage: "At most 500 files, 100 directories, first 1000 entries per directory, 64 KiB per file and 50 matches; hidden and generated directories excluded." };
}
