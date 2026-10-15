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

export const RESTART_DELAY_MS = 10_000;
const PARENT_POLL_MS = 1_000;
const PREDECESSOR_WAIT_MS = 15_000;

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

function killTree(child: ChildProcess | undefined): void {
  if (child?.pid && child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A restarted task must not run two daemons under one identity while the old host winds down. */
async function awaitPredecessor(pidFile: string): Promise<void> {
  let previous: number | undefined;
  try { previous = Number.parseInt(readFileSync(pidFile, 'utf8'), 10); } catch { return; }
  const deadline = Date.now() + PREDECESSOR_WAIT_MS;
  while (previous && previous !== process.pid && isAlive(previous) && Date.now() < deadline) await sleep(250);
}

function runOnce(logFile: string, command: string, args: string[], track: (child: ChildProcess) => void): Promise<number> {
  const log = openSync(logFile, 'a');
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ['ignore', log, log], windowsHide: true });
    track(child);
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
  writeFileSync(pidFile, String(process.pid));
  let child: ChildProcess | undefined;
  const parent = process.ppid;
  const watch = setInterval(() => {
    if (isAlive(parent)) return;
    killTree(child);
    rmSync(pidFile, { force: true });
    process.exit(0);
  }, PARENT_POLL_MS);
  for (;;) {
    const code = await runOnce(logFile, command, args, started => { child = started; });
    if (code === 0) break;
    await sleep(RESTART_DELAY_MS);
  }
  clearInterval(watch);
  rmSync(pidFile, { force: true });
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  host().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
