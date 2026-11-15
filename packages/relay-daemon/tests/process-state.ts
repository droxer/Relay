import { readFileSync } from "node:fs";

/** Whether `pid` can still execute: gone and zombie (unreaped) both read as false. */
export function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const state = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[0];
    return state !== "Z" && state !== "X";
  } catch {
    return false;
  }
}
