/**
 * A Windows run's process tree, found without process groups. Windows never
 * reparents an orphan: a process keeps its dead parent's id as
 * `ParentProcessId`, so every descendant a bash script started stays reachable
 * from the root's pid even after bash itself exited — which `taskkill /T`,
 * walking only live parents, misses. Creation times rule out recycled pids: a
 * process can only descend from one that was created before it.
 */
import { execFile, execFileSync } from "node:child_process";

export interface WindowsProcess { pid: number; parentPid: number; createdAt: number }

/** How far a root's recorded spawn time may differ from the creation time Windows reports. */
const ROOT_CLOCK_SKEW_MS = 10_000;
const LIST_TIMEOUT_MS = 15_000;
const LIST_MAX_BUFFER = 16 * 1024 * 1024;
const POWERSHELL = "powershell.exe";
const LIST_SCRIPT = "Get-CimInstance Win32_Process | ForEach-Object { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() }";
const LIST_ARGS = ["-NoProfile", "-NonInteractive", "-Command", LIST_SCRIPT];

export function parseWindowsProcesses(output: string): WindowsProcess[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const match = /^(\d+) (\d+) (-?\d+)$/.exec(line.trim());
    return match ? [{ pid: Number(match[1]), parentPid: Number(match[2]), createdAt: Number(match[3]) }] : [];
  });
}

/** Every process on the machine; undefined when Windows could not be asked. */
export function listWindowsProcesses(): Promise<WindowsProcess[] | undefined> {
  return new Promise((resolve) => {
    execFile(POWERSHELL, LIST_ARGS, { encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : parseWindowsProcesses(stdout));
    });
  });
}

export function listWindowsProcessesSync(): WindowsProcess[] | undefined {
  try {
    return parseWindowsProcesses(execFileSync(POWERSHELL, LIST_ARGS, {
      encoding: "utf8", timeout: LIST_TIMEOUT_MS, maxBuffer: LIST_MAX_BUFFER, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
    }));
  } catch {
    return undefined;
  }
}

/**
 * The live members of the tree rooted at `rootPid`, spawned at `rootStartedAt`:
 * the root itself while it runs, and every process descending from it.
 */
export function windowsProcessTree(processes: WindowsProcess[], rootPid: number, rootStartedAt: number): number[] {
  const created = new Map<number, number>([[rootPid, rootStartedAt - ROOT_CLOCK_SKEW_MS]]);
  const members: number[] = [];
  const root = processes.find((entry) => entry.pid === rootPid);
  if (root && Math.abs(root.createdAt - rootStartedAt) <= ROOT_CLOCK_SKEW_MS) {
    created.set(rootPid, root.createdAt);
    members.push(rootPid);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of processes) {
      if (created.has(entry.pid) || entry.pid === entry.parentPid) continue;
      const parentCreated = created.get(entry.parentPid);
      if (parentCreated === undefined || entry.createdAt < parentCreated) continue;
      created.set(entry.pid, entry.createdAt);
      members.push(entry.pid);
      grew = true;
    }
  }
  return members;
}

/** `taskkill` arguments that force-end every given pid in one call. */
export function taskkillArguments(pids: number[]): string[] {
  return ["/F", ...pids.flatMap((pid) => ["/PID", String(pid)])];
}
