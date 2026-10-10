import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type { DaemonNodeHeartbeatSettings, DaemonNodeSandboxMode } from "relay-core";

interface ManagedEnrollment {
  sandboxId: string;
  token: string;
  employeeId?: string;
  sandboxMode?: DaemonNodeSandboxMode;
  heartbeat?: DaemonNodeHeartbeatSettings;
}

/** Host-private state: never put the runtime credential in the guest workspace. */
export function loadManagedEnrollment(path: string): ManagedEnrollment | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as ManagedEnrollment;
    if (typeof value.sandboxId !== "string" || !value.sandboxId || typeof value.token !== "string" || !value.token) {
      throw new Error("Saved managed enrollment is incomplete.");
    }
    return value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

export function saveManagedEnrollment(path: string, enrollment: ManagedEnrollment): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, JSON.stringify(enrollment)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
