/** The computers this account already installed, read back from the service files the installer wrote. */
import { readFileSync, unlinkSync } from 'node:fs';
import { installedServices, serviceArguments, type InstalledService } from './control.js';
import { decodeServiceFile, deleteWindowsTask, stopWindowsTask } from './windows-service.js';

export { serviceArguments };

export interface InstalledComputer extends InstalledService {
  backendUrl: string;
  userId: string;
  workspace: string;
}

export interface ServiceRunner {
  run(command: string, args: string[], options?: { inherit?: boolean }): { status: number | null; stdout: string };
  /** Blocking pause between state polls; tests pass a no-op. */
  sleep?(ms: number): void;
}

/** `launchctl print` exits 113 once launchd no longer knows the label. */
const LAUNCHD_NO_SUCH_SERVICE = 113;
const UNLOAD_POLL_MS = 250;
const UNLOAD_CLEANUP_MS = 30_000;
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/**
 * Boots a launchd service out and waits until launchd forgets its label.
 * bootout returns while the old process is still exiting, and bootstrapping
 * the label before then fails with "5: Input/output error".
 */
export function bootoutLaunchdService(runner: ServiceRunner, target: string): boolean {
  // Match the daemon's default/configured active-run grace, then leave time for
  // its stopped registration, environment cleanup and launchd label removal.
  const configuredGrace = Number(process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS);
  const shutdownGraceMs = Number.isFinite(configuredGrace) && configuredGrace > 0
    ? Math.floor(configuredGrace) : 10_000;
  const unloadPolls = Math.ceil((shutdownGraceMs + UNLOAD_CLEANUP_MS) / UNLOAD_POLL_MS);
  // An already unloaded service can reject bootout; print must prove the label is absent.
  runner.run('launchctl', ['bootout', target]);
  for (let poll = 0; ; poll++) {
    if (runner.run('launchctl', ['print', target]).status === LAUNCHD_NO_SUCH_SERVICE) return true;
    if (poll >= unloadPolls) return false;
    (runner.sleep ?? sleepSync)(UNLOAD_POLL_MS);
  }
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Installed computers whose service names a backend, user and workspace; unreadable files are skipped. */
export function installedComputers(platform: string, home: string): InstalledComputer[] {
  return installedServices(platform, home).flatMap(service => {
    let argv: string[];
    try { argv = serviceArguments(platform, decodeServiceFile(readFileSync(service.file))); } catch { return []; }
    const backendUrl = option(argv, '--backend-url');
    const userId = option(argv, '--user-id') ?? option(argv, '--employee-id');
    const workspace = option(argv, '--workspace');
    return backendUrl && userId && workspace ? [{ ...service, backendUrl, userId, workspace }] : [];
  });
}

/** One backend plus one workspace is one computer; every service for it is the same install. */
export function sameComputer(computer: InstalledComputer, backendUrl: string, workspace: string): boolean {
  return origin(computer.backendUrl) === origin(backendUrl) && computer.workspace === workspace;
}

function origin(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/** Disables automatic restart and confirms the service is stopped before releasing its identity. */
export function stopService(platform: string, uid: number, service: InstalledService, runner: ServiceRunner): void {
  const failure = () => new Error(`Cannot stop Relay service ${service.name}; its service file has been preserved.`);
  if (platform === 'darwin') {
    const target = `gui/${uid}/${service.name}`;
    if (runner.run('launchctl', ['disable', target]).status !== 0) throw failure();
    if (!bootoutLaunchdService(runner, target)) throw failure();
  } else if (platform === 'win32') {
    if (!stopWindowsTask(runner, service.name)) throw failure();
  } else {
    const unit = `${service.name}.service`;
    if (runner.run('systemctl', ['--user', 'disable', '--now', unit]).status !== 0) throw failure();
    const state = runner.run('systemctl', ['--user', 'is-active', unit]);
    if (state.status !== 3 || !['inactive', 'failed'].includes(state.stdout.trim())) throw failure();
  }
}

/** Stops and deletes a superseded service so `relay status` lists only the live install. */
export function removeService(platform: string, uid: number, service: InstalledService, runner: ServiceRunner): void {
  stopService(platform, uid, service, runner);
  if (platform === 'win32') deleteWindowsTask(runner, service.name);
  unlinkSync(service.file);
}
