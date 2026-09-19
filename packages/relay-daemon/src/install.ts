/** Personal-computer installer entrypoint. Included only in the downloadable client. */
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRelayDaemonDoctor } from './index.js';

interface InstallOptions {
  backendUrl: string;
  sandboxId: string;
  employeeId: string;
  workspace: string;
  foreground: boolean;
}

export function parseInstallArgs(args: string[]): InstallOptions {
  const values = new Map<string, string>();
  let foreground = false;
  for (let i = 0; i < args.length; i++) {
    const key = args[i]!;
    if (key === '--foreground') { foreground = true; continue; }
    if (!['--backend-url', '--sandbox-id', '--employee-id', '--workspace'].includes(key)) throw new Error(`Unknown installer option: ${key}`);
    const value = args[++i];
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${key}`);
    values.set(key, value);
  }
  for (const key of ['--backend-url', '--sandbox-id', '--employee-id', '--workspace']) {
    if (!values.has(key)) throw new Error(`Missing ${key}`);
  }
  const backendUrl = values.get('--backend-url')!;
  const url = new URL(backendUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Backend must use HTTPS (HTTP is allowed for loopback only).');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Backend URL must be an origin.');
  const sandboxId = values.get('--sandbox-id')!;
  const employeeId = values.get('--employee-id')!;
  for (const [key, value] of [['sandbox-id', sandboxId], ['employee-id', employeeId]]) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value!)) throw new Error(`Invalid --${key}`);
  }
  const workspace = values.get('--workspace')!;
  if (!isAbsolute(workspace)) throw new Error('Workspace must be an absolute path.');
  return { backendUrl, sandboxId, employeeId, workspace, foreground };
}

const xml = (value: string): string => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const systemd = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
const shell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function serviceDefinition(platform: string, id: string, argv: string[], logDir: string, path: string): { name: string; content: string } {
  const name = `build.relay.computer.${id}`;
  if (platform === 'darwin') {
    return { name, content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${name}</string>
<key>ProgramArguments</key><array>${argv.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string>
<key>RELAY_DAEMON_STATE_DIR</key><string>${xml(dirname(logDir))}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(logDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, 'service.log'))}</string>
</dict></plist>\n` };
  }
  if (platform !== 'linux') throw new Error('Only macOS and Linux services are supported.');
  return { name, content: `[Unit]
Description=Relay personal computer ${id}
After=network-online.target
[Service]
Type=simple
ExecStart=${argv.map(systemd).join(' ')}
Environment=${systemd(`PATH=${path}`).replace(/\$\$/g, '$')}
Environment=${systemd(`RELAY_DAEMON_STATE_DIR=${dirname(logDir)}`).replace(/\$\$/g, '$')}
Restart=always
RestartSec=10
UMask=0077
[Install]
WantedBy=default.target
` };
}

async function install(): Promise<void> {
  const options = parseInstallArgs(process.argv.slice(2));
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Only macOS and Linux are supported.');
  if (!options.foreground && process.platform === 'linux') {
    const probe = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    if (probe.status !== 0) throw new Error('A systemd user session is required. Re-run the same installation command with --foreground to run in this terminal.');
  }
  if (!process.env.RELAY_DAEMON_NODE_TOKEN?.trim()) throw new Error('A node token is required.');
  const stateDir = join(homedir(), '.relay', 'daemon-nodes', options.sandboxId);
  process.env.RELAY_DAEMON_STATE_DIR = stateDir;
  console.log('Checking backend, workspace and node credentials…');
  // Missing agent CLIs do not block computer enrollment; they can be installed later.
  const report = await runRelayDaemonDoctor({
    backendUrl: options.backendUrl, sandboxId: options.sandboxId,
    employeeId: options.employeeId, workspacePath: options.workspace,
    sandbox: 'none', allowHostAgentExecution: true, stateDir,
    token: process.env.RELAY_DAEMON_NODE_TOKEN,
    signal: AbortSignal.timeout(60_000),
  });
  const failures = report.checks.filter(check => !check.ok && !check.name.startsWith('agent:'));
  if (failures.length) throw new Error(failures.map(check => `${check.name}: ${check.detail}`).join('\n'));
  delete process.env.RELAY_DAEMON_NODE_TOKEN;
  delete process.env.RELAY_DAEMON_TOKEN;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const argv = [process.execPath, cli, '--backend-url', options.backendUrl, '--sandbox-id', options.sandboxId,
    '--employee-id', options.employeeId, '--workspace', options.workspace, '--sandbox', 'none', '--allow-host-agent-execution'];
  const binDir = join(homedir(), '.local', 'bin');
  mkdirSync(binDir, { recursive: true });
  const wrapper = join(binDir, 'relay-daemon');
  const marker = '# Managed by Relay computer installer';
  if (!existsSync(wrapper) || readFileSync(wrapper, 'utf8').includes(marker)) {
    writeFileSync(wrapper, `#!/bin/sh\n${marker}\nexec ${shell(process.execPath)} ${shell(cli)} "$@"\n`, { mode: 0o755 });
    chmodSync(wrapper, 0o755);
  } else {
    console.log(`Preserving existing executable: ${wrapper}`);
  }
  if (options.foreground) {
    console.log('Starting Relay in this terminal. Press Ctrl+C to stop.');
    const child = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
    return;
  }
  const logDir = join(stateDir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const path = `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  const service = serviceDefinition(process.platform, options.sandboxId, argv, logDir, path);
  if (process.platform === 'darwin') {
    const directory = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${service.name}.plist`);
    writeFileSync(file, service.content, { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`;
    spawnSync('launchctl', ['bootout', `${domain}/${service.name}`], { stdio: 'ignore' });
    execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
    console.log(`Relay service started. Logs: ${join(logDir, 'service.log')}`);
    console.log(`Stop: launchctl bootout ${domain}/${service.name}`);
  } else {
    const directory = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${service.name}.service`), service.content, { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', `${service.name}.service`], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'restart', `${service.name}.service`], { stdio: 'inherit' });
    console.log(`Relay service started. Logs: journalctl --user -u ${service.name}`);
    console.log(`Stop: systemctl --user disable --now ${service.name}`);
  }
  console.log('Relay will start when you log in. Check the computer status in Relay.');
  console.log(`CLI installed at ${wrapper}. Add ${binDir} to PATH for manual commands.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
