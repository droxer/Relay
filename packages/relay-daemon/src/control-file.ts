import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";

export type ControlFileRead =
  | { kind: "absent" | "unsafe" | "oversize" }
  | { kind: "read"; text: string };

/** Consume only a bounded regular file, never an agent-controlled pipe or link. */
export function consumeControlFile(root: string, relativePath: string, limit: number): ControlFileRead {
  const parts = relativePath.split(/[\\/]/);
  if (parts.some(part => !part || part === "." || part === "..")) return { kind: "unsafe" };
  let directory: string;
  try { directory = realpathSync(root); } catch { return { kind: "absent" }; }
  const parents = parts.slice(0, -1);
  const base = directory;
  const safeParents = (): boolean => {
    let current = base;
    for (const part of parents) {
      current = join(current, part);
      const info = lstatSync(current);
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
    }
    return true;
  };
  try {
    if (!safeParents()) return { kind: "unsafe" };
    directory = join(base, ...parents);
  } catch (error) {
    return { kind: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe" };
  }
  const path = join(directory, parts.at(-1)!);
  let info: ReturnType<typeof lstatSync>;
  try { info = lstatSync(path); } catch { return { kind: "absent" }; }
  let fd: number | undefined;
  try {
    if (!info.isFile() || info.isSymbolicLink()) return { kind: "unsafe" };
    // Nonblocking/no-follow defend against a FIFO or link swapped after lstat.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.ino !== info.ino || opened.dev !== info.dev || !safeParents()) return { kind: "unsafe" };
    if (opened.size > limit) return { kind: "oversize" };
    // Read at most limit + 1 even when a file grows after its size check.
    const buffer = Buffer.alloc(limit + 1);
    let total = 0;
    while (total < buffer.length) {
      const count = readSync(fd, buffer, total, buffer.length - total, null);
      if (!count) break;
      total += count;
    }
    if (total > limit) return { kind: "oversize" };
    if (!safeParents()) return { kind: "unsafe" };
    return { kind: "read", text: buffer.subarray(0, total).toString("utf8") };
  } catch {
    return { kind: "unsafe" };
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      // Do not remove a replacement, or follow a replaced parent directory.
      if (safeParents()) {
        const current = lstatSync(path);
        if (current.ino === info.ino && current.dev === info.dev && !current.isDirectory()) rmSync(path, { force: true });
      }
    } catch { /* Unreadable/unremovable control files must not fail the run. */ }
  }
}
