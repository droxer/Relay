/** `relay update` — re-run the published installer for an installed computer, which upgrades it in place. */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { powershellLiteral } from './windows-service.js';
import { readRuntimeProfile } from './runtime-profile.js';

/** Installer options a service keeps in its argv; `--sandbox-id` stays out so the installer reuses the saved token. */
const CARRIED_OPTIONS = ['--backend-url', '--workspace', '--local-permission-policy'];

export interface UpdateCommand { command: string; args: string[] }

function option(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The installer arguments that reproduce this service's setup. */
export function installerArguments(argv: string[]): string[] {
  if (!option(argv, '--backend-url') || !option(argv, '--workspace')) {
    throw new Error('This computer\'s service does not record its backend and workspace; run the install command from Relay instead.');
  }
  const args = CARRIED_OPTIONS.flatMap(name => {
    const value = option(argv, name);
    return value ? [name, value] : [];
  });
  const profile = option(argv, '--runtime-profile');
  if (profile) readRuntimeProfile(profile);
  return profile ? [...args, '--runtime-profile', profile] : args;
}

/** Downloads the backend's current installer and runs it with the service's own setup. */
export function updateCommand(platform: string, argv: string[]): UpdateCommand {
  const args = installerArguments(argv);
  const backend = new URL(option(argv, '--backend-url')!).origin;
  if (platform === 'win32') {
    // Windows PowerShell 5.1 may still default to TLS 1.0 for irm.
    const script = '[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; '
      + `& ([scriptblock]::Create((irm ${powershellLiteral(`${backend}/install.ps1`)}))) ${args.map(powershellLiteral).join(' ')}`;
    return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script] };
  }
  // Arguments travel as positional parameters, never interpolated into the script.
  const script = 'set -o pipefail; curl --fail --silent --show-error --location "$0" | bash -s -- "$@"';
  return { command: 'bash', args: ['-c', script, `${backend}/install.sh`, ...args] };
}

/** Runs the daemon admitted and has not yet confirmed exited; updating restarts the service and interrupts them. */
export function pendingRunCount(home: string, computerId: string): number {
  const directory = join(home, '.relay', 'daemon-nodes', computerId, 'executions');
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter(name => name.endsWith('.json')).length;
}
