/** The computers this account already installed, read back from the service files the installer wrote. */
import { readFileSync, realpathSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootoutLaunchdService, installedServices, serviceArguments, type InstalledService } from './control.js';
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
export function sameComputer(computer: InstalledComputer, backendUrl: string, workspace: string, platform: string = process.platform): boolean {
  return origin(computer.backendUrl) === origin(backendUrl) && workspaceIdentity(computer.workspace, platform) === workspaceIdentity(workspace, platform);
}

/**
 * The directory a workspace path names, however it was typed: symlinks
 * resolved (macOS `/tmp` is `/private/tmp`) and the on-disk spelling of a
 * case-insensitive volume. Windows paths also compare without case, since a
 * drive letter's case is not preserved everywhere.
 */
export function workspaceIdentity(path: string, platform: string = process.platform): string {
  let canonical: string;
  try { canonical = realpathSync.native(path); } catch { canonical = resolve(path); }
  return platform === 'win32' ? canonical.toLowerCase() : canonical;
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
