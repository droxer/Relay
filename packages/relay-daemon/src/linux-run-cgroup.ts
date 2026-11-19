import { randomUUID } from "node:crypto";
import {
  accessSync, closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, rmdirSync, statSync, statfsSync, writeFileSync,
} from "node:fs";
import { join, posix } from "node:path";

const CGROUP_MOUNT = "/sys/fs/cgroup";
const CGROUP2_SUPER_MAGIC = 0x63677270;
const RUN_NAME = /^relay-run-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

interface CgroupLocation {
  parent: string;
  bootId: string;
  namespace: string;
  mountInode: string;
}

export interface LinuxRunCgroup extends CgroupLocation {
  name: string;
  inode: string;
}

export function isLinuxRunCgroup(value: unknown): value is LinuxRunCgroup {
  const group = value as Partial<LinuxRunCgroup> | null;
  return !!group && typeof group.name === "string" && RUN_NAME.test(group.name)
    && typeof group.parent === "string" && typeof group.bootId === "string"
    && typeof group.namespace === "string" && typeof group.mountInode === "string"
    && typeof group.inode === "string";
}

function currentLocation(): CgroupLocation | undefined {
  if (process.platform !== "linux") return undefined;
  if (statfsSync(CGROUP_MOUNT).type !== CGROUP2_SUPER_MAGIC) return undefined;
  const path = /^0::(\/[^\n]*)$/m.exec(readFileSync("/proc/self/cgroup", "utf8"))?.[1];
  if (!path || path === "/" || posix.normalize(path) !== path) return undefined;
  const parent = join(CGROUP_MOUNT, path);
  if (realpathSync(parent) !== parent) return undefined;
  // Verify this mount shows our own cgroup, including in container namespaces.
  if (!readFileSync(join(parent, "cgroup.procs"), "utf8").split("\n").includes(String(process.pid))) return undefined;
  return {
    parent,
    bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
    namespace: statSync("/proc/self/ns/cgroup", { bigint: true }).ino.toString(),
    mountInode: statSync(CGROUP_MOUNT, { bigint: true }).ino.toString(),
  };
}

export function createLinuxRunCgroup(): LinuxRunCgroup | undefined {
  try {
    const location = currentLocation();
    if (!location) return undefined;
    accessSync(join(location.parent, "cgroup.procs"), constants.W_OK);
    const name = `relay-run-${randomUUID()}`;
    const path = join(location.parent, name);
    mkdirSync(path);
    try {
      accessSync(join(path, "cgroup.procs"), constants.W_OK);
      // Test the operation on the still-empty cgroup. A writable control
      // file alone does not guarantee the kernel supports killing this group.
      writeFileSync(join(path, "cgroup.kill"), "1", { flag: "w" });
      return { ...location, name, inode: statSync(path, { bigint: true }).ino.toString() };
    } catch {
      rmdirSync(path);
    }
  } catch {
    // Older kernels and non-delegated services use the existing host adapter.
  }
  return undefined;
}

export function linuxRunInvocation(group: LinuxRunCgroup, command: string, args: string[]) {
  // The launcher only runs the agent after entering the cgroup. A descendant
  // inherits membership even if it creates a new session or process group.
  return { command: "/bin/sh", args: [
    "-c", 'printf "%s\\n" "$$" > "$1" || exit 125; shift; exec "$@"',
    "relay-run", join(group.parent, group.name, "cgroup.procs"), command, ...args,
  ] };
}

/** An empty directory can be removed atomically. Once removed, a launcher
 * that survived the daemon cannot enter it and start the command late. */
export function cleanupLinuxRunCgroup(group: LinuxRunCgroup, stop: boolean): boolean {
  try {
    const location = currentLocation();
    if (!isLinuxRunCgroup(group) || !location || location.parent !== group.parent
      || location.bootId !== group.bootId || location.namespace !== group.namespace
      || location.mountInode !== group.mountInode) return false;
    const path = join(location.parent, group.name);
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT";
    }
    try {
      if (fstatSync(fd, { bigint: true }).ino.toString() !== group.inode) return false;
      try {
        rmdirSync(path);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!stop || (code !== "EBUSY" && code !== "ENOTEMPTY")) return false;
      }
      // The open directory pins the identity even if its name is replaced.
      // The kernel kills the whole subtree and serializes against forks.
      writeFileSync(`/proc/self/fd/${fd}/cgroup.kill`, "1", { flag: "w" });
      return false; // Signal delivery is not evidence that the processes exited.
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}
