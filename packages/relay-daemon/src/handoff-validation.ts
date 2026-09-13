import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { DaemonNodeRunCommand } from "relay-core";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const fail = (reason: string): never => { throw new Error(`handoff_validation_failed: ${reason}`); };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Partial evidence only: matching bytes cannot establish correctness or completion. */
export function validateHandoffWorkspace(root: string, command: DaemonNodeRunCommand): string | undefined {
  const payload: unknown = command.handoffValidation;
  if (payload === undefined) return undefined; // Commands accepted by older backends.
  if (!record(payload) || !record(payload.contract)
    || payload.contract.name !== "relay.handoff.validation" || payload.contract.version !== 1
    || typeof payload.assignmentId !== "string" || !payload.assignmentId
    || payload.assignmentId !== command.assignmentId
    || payload.workspaceLayout !== (command.workspaceLayout ?? "node-root")
    || payload.workspaceSubpath !== (command.workspaceSubpath ?? null)
    || !Array.isArray(payload.artifacts) || payload.artifacts.length > 24) {
    return fail("invalid contract or receiver identity.");
  }
  let matched = 0;
  let unavailable = 0;
  for (const [index, artifact] of payload.artifacts.entries()) {
    if (!record(artifact) || typeof artifact.artifactId !== "string" || !artifact.artifactId
      || typeof artifact.path !== "string" || artifact.path.length > 512
      || /[\\:\x00]/.test(artifact.path)
      || artifact.path.split("/").some((part) => !part || part === "." || part === "..")
      || (artifact.sha256 !== null && (typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(artifact.sha256)))) {
      return fail(`invalid artifact ${index + 1}.`);
    }
    if (artifact.sha256 === null) {
      unavailable += 1;
      continue;
    }
    try {
      if (hashRegularFile(root, artifact.path) !== artifact.sha256) return fail("recorded file bytes changed.");
    } catch {
      // Never expose host paths, file bytes, or OS error details to the thread.
      return fail(`artifact ${index + 1} changed, is missing, unsafe, or exceeds the read limit. Review the live workspace before requesting new work.`);
    }
    matched += 1;
  }
  return `[Runtime handoff validation]\n${matched} recorded file hashes matched; ${unavailable} snapshots unavailable. Evidence coverage remains partial. Verify the live work and claims; this is not completion approval.`;
}

function hashRegularFile(root: string, path: string): string {
  const base = realpathSync(root);
  const parts = path.split("/");
  const target = join(base, ...parts);
  const checkPath = (): void => {
    let current = base;
    for (const [index, part] of parts.entries()) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) fail("unsafe file path.");
    }
    if (realpathSync(target) !== target) fail("workspace path changed.");
  };
  checkPath();
  // Nonblocking + no-follow also prevent a swapped FIFO or leaf symlink from
  // blocking the daemon. Parent paths are checked before and after the read.
  // The gate excludes Relay writers; this is not a hostile-host OS sandbox.
  const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > MAX_FILE_BYTES) fail("not a bounded regular file.");
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      if (total > MAX_FILE_BYTES) fail("file grew beyond the read limit.");
      hash.update(buffer.subarray(0, count));
    }
    const after = fstatSync(fd);
    checkPath();
    const current = lstatSync(target);
    if (total !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs || current.ino !== after.ino || current.dev !== after.dev) fail("file changed during validation.");
    return hash.digest("hex");
  } finally {
    closeSync(fd);
  }
}
