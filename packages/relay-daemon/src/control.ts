/** `relay` — start, stop and inspect the background services the computer installer created. */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SERVICE_PREFIX = 'build.relay.computer.';
const LOG_LINES = '100';
const COMMANDS = ['start', 'stop', 'restart', 'status', 'logs'];

export interface InstalledService { id: string; name: string; file: string }
export interface CommandResult { status: number | null; stdout: string }
export interface ControlDeps {
  platform: string;
  home: string;
  uid: number;
  run(command: string, args: string[], options?: { inherit?: boolean }): CommandResult;
  log(line: string): void;
}

const HELP = `relay <command> [--computer <id>]

Control the Relay service installed on this computer.

Commands:
  start     Start Relay now and at every login.
  stop      Stop Relay and keep it stopped, also after login, until "relay start".
  restart   Restart Relay (for example after changing agent CLI settings).
  status    Show whether Relay is running.
  logs      Show recent Relay output. Add --follow to keep streaming.

Options:
  --computer <id>   Act on one connected computer when several are installed.
  --follow          With "logs", stream new output until Ctrl+C.
  --help            Show this help message.
`;

function serviceDirectory(platform: string, home: string): string {
  if (platform === 'darwin') return join(home, 'Library', 'LaunchAgents');
  if (platform === 'linux') return join(home, '.config', 'systemd', 'user');
  throw new Error('Relay supports macOS and Linux.');
}

export function installedServices(platform: string, home: string): InstalledService[] {
  const directory = serviceDirectory(platform, home);
  if (!existsSync(directory)) return [];
  const suffix = platform === 'darwin' ? '.plist' : '.service';
  return readdirSync(directory)
    .filter(file => file.startsWith(SERVICE_PREFIX) && file.endsWith(suffix))
    .sort()
    .map(file => {
      const name = file.slice(0, -suffix.length);
      return { id: name.slice(SERVICE_PREFIX.length), name, file: join(directory, file) };
    });
}

interface ControlArgs { command: string; computer?: string; follow: boolean }

export function parseControlArgs(args: string[]): ControlArgs {
  let command = '';
  let computer: string | undefined;
  let follow = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h' || arg === 'help') return { command: 'help', follow };
    if (arg === '--follow' || arg === '-f') { follow = true; continue; }
    if (arg === '--computer') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new Error('--computer requires a computer id.');
      computer = value;
      continue;
    }
    if (arg.startsWith('-') || command) throw new Error(`Unknown argument: ${arg}`);
    command = arg;
  }
  return { command: command || 'help', follow, ...(computer ? { computer } : {}) };
}

/** Whether a service is running, as reported by launchd or systemd. */
function serviceState(deps: ControlDeps, service: InstalledService): { running: boolean; detail: string } {
  if (deps.platform === 'darwin') {
    const result = deps.run('launchctl', ['print', `gui/${deps.uid}/${service.name}`]);
    const pid = result.status === 0 ? /^\s*pid = (\d+)/m.exec(result.stdout)?.[1] : undefined;
    return pid ? { running: true, detail: `running (pid ${pid})` } : { running: false, detail: 'stopped' };
  }
  const state = deps.run('systemctl', ['--user', 'is-active', `${service.name}.service`]).stdout.trim() || 'unknown';
  return state === 'active' ? { running: true, detail: 'running' } : { running: false, detail: state === 'inactive' ? 'stopped' : state };
}

function start(deps: ControlDeps, service: InstalledService, restart: boolean): boolean {
  if (deps.platform === 'darwin') {
    const target = `gui/${deps.uid}/${service.name}`;
    // "relay stop" disables the label so login does not start it; undo that first.
    deps.run('launchctl', ['enable', target]);
    // Bootstrap fails when the service is already loaded; kickstart covers both cases.
    deps.run('launchctl', ['bootstrap', `gui/${deps.uid}`, service.file]);
    return deps.run('launchctl', ['kickstart', ...(restart ? ['-k'] : []), target]).status === 0;
  }
  const unit = `${service.name}.service`;
  if (deps.run('systemctl', ['--user', 'enable', unit]).status !== 0) return false;
  return deps.run('systemctl', ['--user', restart ? 'restart' : 'start', unit]).status === 0;
}

function stop(deps: ControlDeps, service: InstalledService): boolean {
  if (deps.platform === 'darwin') {
    const target = `gui/${deps.uid}/${service.name}`;
    if (deps.run('launchctl', ['disable', target]).status !== 0) return false;
    // An unloaded service is already stopped, which bootout reports as a failure.
    deps.run('launchctl', ['bootout', target]);
    return !serviceState(deps, service).running;
  }
  return deps.run('systemctl', ['--user', 'disable', '--now', `${service.name}.service`]).status === 0;
}

function logs(deps: ControlDeps, service: InstalledService, follow: boolean): boolean {
  if (deps.platform === 'darwin') {
    const file = join(deps.home, '.relay', 'daemon-nodes', service.id, 'logs', 'service.log');
    if (!existsSync(file)) { deps.log('No Relay logs yet.'); return true; }
    return deps.run('tail', ['-n', LOG_LINES, ...(follow ? ['-f'] : []), file], { inherit: true }).status === 0;
  }
  return deps.run('journalctl', ['--user', '-u', `${service.name}.service`, '-n', LOG_LINES, '--no-pager', ...(follow ? ['-f'] : [])], { inherit: true }).status === 0;
}

function selectServices(deps: ControlDeps, computer: string | undefined): InstalledService[] {
  const services = installedServices(deps.platform, deps.home);
  if (!services.length) throw new Error('Relay is not installed on this computer. Run the install command from Relay first.');
  if (!computer) return services;
  const match = services.filter(service => service.id === computer);
  if (!match.length) throw new Error(`No installed computer "${computer}". Installed: ${services.map(service => service.id).join(', ')}`);
  return match;
}

function applyCommand(deps: ControlDeps, command: string, service: InstalledService): { ok: boolean; message: string } {
  if (command === 'status') return { ok: true, message: `Relay is ${serviceState(deps, service).detail}.` };
  if (command === 'stop') {
    const ok = stop(deps, service);
    return { ok, message: ok ? 'Relay stopped. Run "relay start" to start it again.' : 'Relay could not be stopped.' };
  }
  const ok = start(deps, service, command === 'restart');
  const verb = command === 'restart' ? 'restarted' : 'started';
  return { ok, message: ok ? `Relay ${verb}.` : `Relay could not be ${verb}. Run "relay logs" for details.` };
}

/** Runs one control command and returns the process exit code. */
export function runControl(args: string[], deps: ControlDeps): number {
  const options = parseControlArgs(args);
  if (options.command === 'help') { deps.log(HELP); return 0; }
  if (!COMMANDS.includes(options.command)) throw new Error(`Unknown command: ${options.command}. Run "relay --help".`);
  const services = selectServices(deps, options.computer);
  if (options.command === 'logs') {
    if (services.length > 1) throw new Error(`Several computers are installed; choose one with --computer <id>: ${services.map(service => service.id).join(', ')}`);
    return logs(deps, services[0]!, options.follow) ? 0 : 1;
  }
  let ok = true;
  for (const service of services) {
    const result = applyCommand(deps, options.command, service);
    ok &&= result.ok;
    // Name the computer only when there is more than one to tell apart.
    deps.log(services.length > 1 ? `${service.id}: ${result.message}` : result.message);
  }
  return ok ? 0 : 1;
}

export function systemControlDeps(): ControlDeps {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? 0,
    run: (command, args, options) => {
      const result = spawnSync(command, args, { encoding: 'utf8', stdio: options?.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
      if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
      return { status: result.status, stdout: result.stdout ?? '' };
    },
    log: line => console.log(line),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runControl(process.argv.slice(2), systemControlDeps());
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
