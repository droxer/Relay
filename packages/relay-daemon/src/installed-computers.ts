/** The computers this account already installed, read back from the service files the installer wrote. */
import { readFileSync, unlinkSync } from 'node:fs';
import { installedServices, type InstalledService } from './control.js';

export interface InstalledComputer extends InstalledService {
  backendUrl: string;
  employeeId: string;
  workspace: string;
}

export interface ServiceRunner {
  run(command: string, args: string[]): { status: number | null; stdout: string };
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const SYSTEMD_ESCAPES: Record<string, string> = { n: '\n', r: '\r' };

/** Inverse of `serviceDefinition`: the argv a launchd plist or systemd unit runs. */
export function serviceArguments(platform: string, content: string): string[] {
  if (platform === 'darwin') {
    const array = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(content)?.[1] ?? '';
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)]
      .map(match => match[1]!.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!));
  }
  const exec = /^ExecStart=(.*)$/m.exec(content)?.[1] ?? '';
  return [...exec.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map(match => match[1]!
    .replace(/\\(.)/g, (_, char: string) => SYSTEMD_ESCAPES[char] ?? char)
    .replace(/%%/g, '%')
    .replace(/\$\$/g, '$'));
}

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** Installed computers whose service names a backend, employee and workspace; unreadable files are skipped. */
export function installedComputers(platform: string, home: string): InstalledComputer[] {
  return installedServices(platform, home).flatMap(service => {
    let argv: string[];
    try { argv = serviceArguments(platform, readFileSync(service.file, 'utf8')); } catch { return []; }
    const backendUrl = option(argv, '--backend-url');
    const employeeId = option(argv, '--employee-id');
    const workspace = option(argv, '--workspace');
    return backendUrl && employeeId && workspace ? [{ ...service, backendUrl, employeeId, workspace }] : [];
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
    // An already unloaded service can reject bootout; print must prove the label is absent.
    runner.run('launchctl', ['bootout', target]);
    if (runner.run('launchctl', ['print', target]).status !== 113) throw failure();
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
  unlinkSync(service.file);
}
