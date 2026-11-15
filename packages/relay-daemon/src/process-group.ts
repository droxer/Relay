import { readdirSync, readFileSync } from "node:fs";

/**
 * Whether any member of a host process group can still execute.
 *
 * `kill(-group, 0)` succeeds while the group holds only zombies, and a killed
 * orphan stays a zombie for good when the host's PID 1 never reaps it — a
 * container started without `--init` is the common case. Treating that as
 * "still running" holds the run's slot forever. A zombie cannot execute, so
 * on Linux the group is read from `/proc` and zombies are left out, as the
 * guest supervisor already does inside BoxLite.
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
): boolean {
  // The kernel's answer comes first: no such group is proof of exit, and a
  // refusal (EPERM) is no evidence at all, so the caller keeps the run.
  try {
    probe(group);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
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
