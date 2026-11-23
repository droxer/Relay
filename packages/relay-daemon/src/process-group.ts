import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

function listDarwinProcessStates(): string {
  return execFileSync("/bin/ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_000,
  });
}

function darwinGroupHasOnlyZombies(group: number, list: () => string): boolean {
  let states: string;
  try {
    states = list();
  } catch {
    return false;
  }
  let found = false;
  for (const row of states.trim().split("\n")) {
    const fields = /^\s*(\d+)\s+(\S+)\s*$/.exec(row);
    if (!fields) return false;
    if (Number(fields[1]) !== group) continue;
    if (!fields[2].startsWith("Z")) return false;
    found = true;
  }
  return found;
}

/**
 * Whether any member of a host process group can still execute.
 *
 * `kill(-group, 0)` succeeds while the group holds only zombies, and a killed
 * orphan stays a zombie for good when the host's PID 1 never reaps it — a
 * container started without `--init` is the common case. Treating that as
 * "still running" holds the run's slot forever. A zombie cannot execute, so
 * on Linux the group is read from `/proc` and zombies are left out, as the
 * guest supervisor already does inside BoxLite. On macOS a zombie-only group
 * can refuse the probe, so verify the remaining members with `ps`.
 *
 * Returns false only on evidence that nothing in the group executes; throws
 * when the evidence cannot be read, so a caller keeps retaining the run. The
 * kernel saying the group exists while `/proc` shows none of it (a `hidepid`
 * mount, or a race) is no evidence either way, so the group counts as alive.
 */
export function processGroupAlive(
  group: number,
  platform: NodeJS.Platform = process.platform,
  proc: { list: () => string[]; stat: (pid: string) => string } = {
    list: () => readdirSync("/proc"),
    stat: (pid) => readFileSync(`/proc/${pid}/stat`, "utf8"),
  },
  probe: (group: number) => void = (target) => { process.kill(-target, 0); },
  listDarwin: () => string = listDarwinProcessStates,
): boolean {
  // The kernel's answer comes first. A missing group proves exit, while a
  // refused probe needs separate evidence.
  try {
    probe(group);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // macOS can refuse a probe of a group whose only members are zombies.
    // Require positive evidence of those members before settling the run.
    if (code === "EPERM" && platform === "darwin" && darwinGroupHasOnlyZombies(group, listDarwin)) return false;
    throw error;
  }
  if (platform !== "linux") return true;
  // The group exists; it still executes only if a member is not a zombie.
  let members = 0;
  for (const pid of proc.list()) {
    if (!/^\d+$/.test(pid)) continue;
    let stat: string;
    try {
      stat = proc.stat(pid);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The process exited between listing and reading.
      if (code === "ENOENT" || code === "ESRCH") continue;
      throw error;
    }
    // The command name may hold spaces and parentheses; fields resume after the last `)`.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
    if (Number(fields[2]) !== group) continue;
    members += 1;
    if (fields[0] !== "Z" && fields[0] !== "X") return true;
  }
  return members === 0;
}
