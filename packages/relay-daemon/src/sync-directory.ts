import { closeSync, fsyncSync, openSync } from "node:fs";

/**
 * Flushes a directory entry after a rename so the new name survives a crash.
 * Windows cannot fsync a directory (FlushFileBuffers needs a writable handle
 * and fails with EPERM); NTFS journals the rename itself, so there is nothing
 * to flush there.
 */
export function syncDirectory(directory: string, platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") return;
  const fd = openSync(directory, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
