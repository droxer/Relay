/**
 * What the Windows logon task runs: `windows-service-host.js <log file> <command> [args…]`.
 * It gives the daemon what launchd and systemd give it elsewhere — output appended to
 * service.log, a restart 10 s after a crash, and no restart after a clean exit (a
 * deleted node). It also stops the daemon when Task Scheduler ends the task, since
 * ending kills only the hidden PowerShell that launched this host.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rotateServiceLog } from './service-log.js';
import { listWindowsProcesses, taskkillArguments, windowsProcessTree, type WindowsProcess } from './windows-process-tree.js';

export const RESTART_DELAY_MS = 10_000;
const PARENT_POLL_MS = 1_000;
/** Pids are recycled, so liveness alone cannot tell the parent apart from a successor. */
const PARENT_IDENTITY_POLL_MS = 30_000;
const PREDECESSOR_WAIT_MS = 15_000;

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const createdAt = (processes: WindowsProcess[] | undefined, pid: number): number | undefined =>
  processes?.find(entry => entry.pid === pid)?.createdAt;

/** Ends a tree and everything it orphaned; falls back to `taskkill /T` without a process list. */
async function killTree(pid: number, startedAt: number): Promise<void> {
  const processes = await listWindowsProcesses();
  if (processes) {
    const members = windowsProcessTree(processes, pid, startedAt);
    if (members.length) spawnSync('taskkill', taskkillArguments(members), { stdio: 'ignore', windowsHide: true });
    return;
  }
  if (isAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

/** `<pid> <created-at ms>`; files written by older hosts hold only the pid. */
export function parsePidFile(content: string): { pid: number; createdAt?: number } | undefined {
  const [pid, created] = content.trim().split(/\s+/).map(value => Number.parseInt(value, 10));
  if (!pid) return undefined;
  return created ? { pid, createdAt: created } : { pid };
}

/**
 * A restarted task must not run two daemons under one identity. Wait for the
 * old host to wind down, then end it and its daemon if it will not.
 */
async function awaitPredecessor(pidFile: string): Promise<void> {
  let previous: ReturnType<typeof parsePidFile>;
  try { previous = parsePidFile(readFileSync(pidFile, 'utf8')); } catch { return; }
  if (!previous || previous.pid === process.pid) return;
  const deadline = Date.now() + PREDECESSOR_WAIT_MS;
  while (isAlive(previous.pid) && Date.now() < deadline) await sleep(250);
  // Without its creation time the pid may already belong to an unrelated process.
  if (isAlive(previous.pid) && previous.createdAt !== undefined) await killTree(previous.pid, previous.createdAt);
}

function runOnce(logFile: string, command: string, args: string[], track: (child: ChildProcess, startedAt: number) => void): Promise<number> {
  rotateServiceLog(logFile);
  const log = openSync(logFile, 'a');
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', log, log], windowsHide: true });
    track(child, Date.now());
    let settled = false;
    const settle = (code: number) => { if (settled) return; settled = true; closeSync(log); resolve(code); };
    child.on('error', error => { writeFileSync(log, `[relay] Cannot start Relay: ${error.message}\n`); settle(1); });
    child.on('close', code => settle(code ?? 1));
  });
}

async function host(): Promise<void> {
  const [logFile, command, ...args] = process.argv.slice(2);
  if (!logFile || !command) throw new Error('Usage: windows-service-host <log file> <command> [args…]');
  mkdirSync(dirname(logFile), { recursive: true });
  const pidFile = join(dirname(logFile), 'service-host.pid');
  await awaitPredecessor(pidFile);
  const snapshot = await listWindowsProcesses();
  const ownCreatedAt = createdAt(snapshot, process.pid);
  writeFileSync(pidFile, ownCreatedAt === undefined ? String(process.pid) : `${process.pid} ${ownCreatedAt}`);
  let child: { process: ChildProcess; startedAt: number } | undefined;
  const parent = process.ppid;
  const parentCreatedAt = createdAt(snapshot, parent);
  let lastIdentityCheck = Date.now();
  let stopping = false;
  const parentGone = async (): Promise<boolean> => {
    if (!isAlive(parent)) return true;
    if (parentCreatedAt === undefined || Date.now() - lastIdentityCheck < PARENT_IDENTITY_POLL_MS) return false;
    lastIdentityCheck = Date.now();
    const current = await listWindowsProcesses();
    // A list that cannot be read proves nothing; keep running.
    return current !== undefined && createdAt(current, parent) !== parentCreatedAt;
  };
  const watch = setInterval(() => {
    if (stopping) return;
    void parentGone().then(async gone => {
      if (!gone || stopping) return;
      stopping = true;
      if (child?.process.pid) await killTree(child.process.pid, child.startedAt);
      rmSync(pidFile, { force: true });
      process.exit(0);
    });
  }, PARENT_POLL_MS);
  for (;;) {
    const code = await runOnce(logFile, command, args, (started, startedAt) => { child = { process: started, startedAt }; });
    if (code === 0) break;
    await sleep(RESTART_DELAY_MS);
  }
  clearInterval(watch);
  rmSync(pidFile, { force: true });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  host().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
