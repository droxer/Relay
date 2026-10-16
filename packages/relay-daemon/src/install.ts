/** Personal-computer installer entrypoint. Included only in the downloadable client. */
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, accessSync, constants } from 'node:fs';
import { authorizeComputer } from './device-setup.js';
import { runRelayDaemonDoctor } from './index.js';
import { applyLocalRuntimeEnvironment, ensureDaemonNodeToken, localRuntimeEnvironment, readDaemonNodeToken, relayApiUrl } from 'relay-core';
import { BRAND_ENV, brandForBackend, LOOPBACK_HOSTS, RELAY_BRAND, RELAY_DEV_BRAND, type RelayBrand } from './control.js';
import { bootoutLaunchdService, installedComputers, removeService, sameComputer, stopService, type InstalledComputer, type ServiceRunner } from './installed-computers.js';
import { captureRuntimeProfile, readRuntimeProfile, runtimeProfileEnvironment, writeRuntimeProfile } from './runtime-profile.js';
import { isUserIdFlag } from './legacy-names.js';
import { localBash } from './local-shell.js';
import { encodeTaskFile, powershellLiteral, registerWindowsTask, windowsAccount, windowsServiceDirectory, windowsTaskDefinition } from './windows-service.js';

interface InstallOptions {
  backendUrl: string;
  sandboxId: string;
  userId: string;
  workspace: string;
  foreground: boolean;
  verbose: boolean;
  deviceSetup: boolean;
  runtimeEnvFile?: string;
  runtimeProfile?: string;
  localPermissionPolicy: "native" | "trusted";
}

export function parseInstallArgs(args: string[]): InstallOptions {
  const values = new Map<string, string>();
  let foreground = false;
  let verbose = false;
  for (let i = 0; i < args.length; i++) {
    // Install commands copied before the user rename still say --employee-id.
    const key = isUserIdFlag(args[i]!) ? '--user-id' : args[i]!;
    if (key === '--foreground') { foreground = true; continue; }
    if (key === '--verbose') { verbose = true; continue; }
    if (!['--backend-url', '--sandbox-id', '--user-id', '--workspace', '--runtime-env-file', '--runtime-profile', '--local-permission-policy'].includes(key)) throw new Error(`Unknown installer option: ${key}`);
    const value = args[++i];
    if (!value || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${key}`);
    values.set(key, value);
  }
  const deviceSetup = !values.has('--sandbox-id');
  for (const key of deviceSetup ? ['--backend-url'] : ['--backend-url', '--sandbox-id', '--user-id', '--workspace']) {
    if (!values.has(key)) throw new Error(`Missing ${key}`);
  }
  const backendUrl = values.get('--backend-url')!;
  const url = new URL(backendUrl);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK_HOSTS.includes(url.hostname))) throw new Error('Backend must use HTTPS (HTTP is allowed for loopback only).');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Backend URL must be an origin.');
  const sandboxId = values.get('--sandbox-id') ?? '';
  const userId = values.get('--user-id') ?? '';
  for (const [key, value] of [['sandbox-id', sandboxId], ['user-id', userId]]) {
    if (!deviceSetup && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value!)) throw new Error(`Invalid --${key}`);
  }
  const workspace = values.get('--workspace') ?? '';
  if ((!deviceSetup || workspace) && !isAbsolute(workspace)) throw new Error('Workspace must be an absolute path.');
  const localPermissionPolicy = values.get('--local-permission-policy') ?? 'native';
  if (localPermissionPolicy !== 'native' && localPermissionPolicy !== 'trusted') throw new Error('Local permission policy must be native or trusted.');
  const runtimeEnvFile = values.get('--runtime-env-file');
  if (runtimeEnvFile && !isAbsolute(runtimeEnvFile)) throw new Error('--runtime-env-file must be an absolute path.');
  const runtimeProfile = values.get('--runtime-profile');
  if (runtimeProfile && !isAbsolute(runtimeProfile)) throw new Error('--runtime-profile must be an absolute path.');
  if (runtimeProfile && runtimeEnvFile) throw new Error('Choose --runtime-profile or --runtime-env-file, not both.');
  return { backendUrl, sandboxId, userId, workspace, foreground, verbose, deviceSetup, localPermissionPolicy, ...(runtimeEnvFile ? { runtimeEnvFile } : {}), ...(runtimeProfile ? { runtimeProfile } : {}) };
}

const xml = (value: string): string => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const systemd = (value: string): string => `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, () => '$$').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
const shell = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export function serviceDefinition(platform: string, id: string, argv: string[], logDir: string, path: string, brand: RelayBrand = RELAY_BRAND, account = windowsAccount()): { name: string; content: string } {
  const name = `build.relay.computer.${id}`;
  if (platform === 'win32') {
    // The service host sits beside cli.js in the same release.
    const hostScript = join(dirname(argv[1] ?? ''), 'windows-service-host.js');
    return { name, content: windowsTaskDefinition({ id, argv, hostScript, logFile: join(logDir, 'service.log'), stateDir: dirname(logDir), path, account, product: brand.product }) };
  }
  // Deleted nodes exit successfully. Recover crashes without restarting an
  // intentional shutdown and repeatedly contacting a deleted registration.
  if (platform === 'darwin') {
    return { name, content: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${name}</string>
<key>ProgramArguments</key><array>${argv.map(arg => `<string>${xml(arg)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string>
<key>RELAY_DAEMON_STATE_DIR</key><string>${xml(dirname(logDir))}</string></dict>
<key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${xml(join(logDir, 'service.log'))}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, 'service.log'))}</string>
</dict></plist>\n` };
  }
  if (platform !== 'linux') throw new Error('Only macOS, Linux and Windows services are supported.');
  return { name, content: `[Unit]
Description=${brand.product} personal computer ${id}
After=network-online.target
[Service]
Type=simple
ExecStart=${argv.map(systemd).join(' ')}
Environment=${systemd(`PATH=${path}`).replace(/\$\$/g, '$')}
Environment=${systemd(`RELAY_DAEMON_STATE_DIR=${dirname(logDir)}`).replace(/\$\$/g, '$')}
Restart=on-failure
RestartSec=10
UMask=0077
[Install]
WantedBy=default.target
` };
}

const LAUNCHER_MARKER = '# Managed by Relay computer installer';

/** The launcher file a platform runs: a POSIX shell script, or a batch file on Windows. */
export function launcherScript(platform: string, node: string, script: string, brand: RelayBrand = RELAY_BRAND): string {
  const dev = brand === RELAY_DEV_BRAND;
  // cmd expands %…% even inside quotes; %% is a literal percent sign.
  const batch = (value: string) => `"${value.replace(/%/g, '%%')}"`;
  if (platform === 'win32') {
    // setlocal keeps the brand variable out of the calling console.
    return `@echo off\r\nrem ${LAUNCHER_MARKER}\r\nsetlocal\r\n${dev ? `set ${BRAND_ENV}=dev\r\n` : ''}${batch(node)} ${batch(script)} %*\r\n`;
  }
  return `#!/bin/sh\n${LAUNCHER_MARKER}\n${dev ? `${BRAND_ENV}=dev ` : ''}exec ${shell(node)} ${shell(script)} "$@"\n`;
}

/** Writes `<binDir>/<name>` to run `script`, unless an unrelated executable already owns that name. */
function installLauncher(binDir: string, name: string, script: string, brand: RelayBrand): string | undefined {
  mkdirSync(binDir, { recursive: true });
  const launcher = join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
  if (existsSync(launcher) && !readFileSync(launcher, 'utf8').includes(LAUNCHER_MARKER)) {
    console.log(`Preserving existing executable: ${launcher}`);
    return undefined;
  }
  writeFileSync(launcher, launcherScript(process.platform, process.execPath, script, brand), { mode: 0o755 });
  chmodSync(launcher, 0o755);
  return launcher;
}

function openBrowser(url: string): void {
  console.log(`Confirm this computer in your browser:\n${url}`);
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  const browser = spawn(command as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true });
  browser.on('error', () => { console.log('Open the URL above in a browser to continue.'); });
  browser.unref();
}

/** How to run the control CLI in the shell the user installed from. */
function controlCommand(control: string): string {
  return process.platform === 'win32' ? `& ${powershellLiteral(control)}` : shell(control);
}

/**
 * The installed computer this run should upgrade: same backend and workspace, a saved token, and
 * a backend that still accepts it. A deleted or rejected node falls back to a fresh authorization.
 */
async function reusableComputer(installed: InstalledComputer[], backendUrl: string, workspace: string): Promise<{ computer: InstalledComputer; token: string } | undefined> {
  const newestFirst = installed.filter(computer => sameComputer(computer, backendUrl, workspace))
    .sort((a, b) => statSync(b.file).mtimeMs - statSync(a.file).mtimeMs);
  for (const computer of newestFirst) {
    const credentials = join(homedir(), '.relay', 'daemon-nodes', computer.id, 'credentials');
    const token = readDaemonNodeToken(credentials, computer.userId);
    if (!token) continue;
    try {
      const response = await fetch(relayApiUrl(backendUrl, `/daemon-nodes/${encodeURIComponent(computer.id)}/auth-check`), {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return { computer, token };
      await response.body?.cancel();
    } catch {
      // An unreachable backend fails the doctor check below with a clearer message.
      return undefined;
    }
  }
  return undefined;
}

function serviceRunner(): ServiceRunner {
  return {
    run: (command, args, options?: { inherit?: boolean }) => {
      const result = spawnSync(command, args, { encoding: 'utf8', stdio: options?.inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true });
      return { status: result.status, stdout: result.stdout ?? '' };
    },
  };
}

/** Removes every other service installed for this backend and workspace: one computer, one service. */
function removeSupersededServices(installed: InstalledComputer[], options: InstallOptions, brand: RelayBrand): void {
  const runner = serviceRunner();
  for (const computer of installed) {
    if (computer.id === options.sandboxId || !sameComputer(computer, options.backendUrl, options.workspace)) continue;
    removeService(process.platform, process.getuid?.() ?? 0, computer, runner);
    console.log(`Removed an older ${brand.product} install for this workspace (${computer.id}).`);
  }
  if (process.platform === 'linux') spawnSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
}

async function install(): Promise<void> {
  const options = parseInstallArgs(process.argv.slice(2));
  const savedProfile = options.runtimeProfile ? readRuntimeProfile(options.runtimeProfile) : undefined;
  if (!['darwin', 'linux', 'win32'].includes(process.platform)) throw new Error('Only macOS, Linux and Windows are supported.');
  // Agent scripts run in bash; fail before authorizing a computer that could never run one.
  if (process.platform === 'win32') localBash();
  if (!options.foreground && process.platform === 'linux') {
    const probe = spawnSync('systemctl', ['--user', 'show-environment'], { stdio: 'ignore' });
    if (probe.status !== 0) throw new Error('A systemd user session is required. Re-run the same installation command with --foreground to run in this terminal.');
  }
  const brand = brandForBackend(options.backendUrl);
  const installed = installedComputers(process.platform, homedir());
  if (options.deviceSetup) {
    // install.sh prompts for it; reading /dev/tty from Node dies on EINTR under sudo.
    if (!options.workspace) throw new Error('Pass --workspace <absolute path> to choose the local workspace directory.');
    if (!isAbsolute(options.workspace) || !statSync(options.workspace).isDirectory()) throw new Error('Choose an existing absolute workspace directory.');
    accessSync(options.workspace, constants.R_OK | constants.W_OK);
    options.workspace = resolve(options.workspace);
  }
  const existing = options.deviceSetup ? await reusableComputer(installed, options.backendUrl, options.workspace) : undefined;
  if (existing) {
    // Re-running the install command upgrades this computer in place: same node, same token, new release.
    console.log(`${brand.product} is already installed for this workspace; upgrading it.`);
    options.sandboxId = existing.computer.id;
    options.userId = existing.computer.userId;
    process.env.RELAY_DAEMON_NODE_TOKEN = existing.token;
  } else if (options.deviceSetup) {
    const authorized = await authorizeComputer({
      backendUrl: options.backendUrl, workspace: options.workspace, displayName: brand === RELAY_DEV_BRAND ? brand.product : hostname().slice(0, 80),
      openBrowser,
    });
    options.sandboxId = authorized.sandboxId;
    options.userId = authorized.userId;
    process.env.RELAY_DAEMON_NODE_TOKEN = authorized.token;
  }
  if (!process.env.RELAY_DAEMON_NODE_TOKEN?.trim()) throw new Error('A node token is required.');
  const stateDir = join(homedir(), '.relay', 'daemon-nodes', options.sandboxId);
  process.env.RELAY_DAEMON_STATE_DIR = stateDir;
  const nodeToken = process.env.RELAY_DAEMON_NODE_TOKEN;
  const runtimeEnv = localRuntimeEnvironment();
  runtimeEnv.PATH = [dirname(process.execPath), runtimeEnv.PATH ?? '/usr/bin:/bin'].join(delimiter);
  const profile = savedProfile ?? (!options.foreground || options.runtimeEnvFile
    ? captureRuntimeProfile(runtimeEnv, options.runtimeEnvFile) : undefined);
  const installerEnvironment = process.env;
  if (profile) {
    // Preflight uses the same selected environment as the installed service.
    const selectedEnvironment = runtimeProfileEnvironment(profile);
    process.env = { ...selectedEnvironment, RELAY_DAEMON_STATE_DIR: stateDir };
    applyLocalRuntimeEnvironment(selectedEnvironment);
  }
  process.env.RELAY_LOCAL_PERMISSION_POLICY = options.localPermissionPolicy;
  console.log('Checking backend, workspace and node credentials…');
  // Missing agent CLIs do not block computer enrollment; they can be installed later.
  let report;
  try {
    report = await runRelayDaemonDoctor({
      backendUrl: options.backendUrl, sandboxId: options.sandboxId,
      userId: options.userId, workspacePath: options.workspace,
      sandbox: 'none', allowHostAgentExecution: true, stateDir,
      token: nodeToken,
      signal: AbortSignal.timeout(60_000),
    });
  } finally {
    process.env = installerEnvironment;
  }
  const failures = report.checks.filter(check => !check.ok && !check.name.startsWith('agent:'));
  if (failures.length) throw new Error(failures.map(check => `${check.name}: ${check.detail}`).join('\n'));
  // Persist the already-issued token only after read-only authentication succeeds.
  // The running daemon owns registration; reinstalling never marks a live node stopped.
  ensureDaemonNodeToken({ credentialDirectory: join(stateDir, 'credentials'), userId: options.userId, token: nodeToken });
  const runtimeProfile = profile ? writeRuntimeProfile(stateDir, profile) : undefined;
  delete process.env.RELAY_DAEMON_NODE_TOKEN;
  delete process.env.RELAY_DAEMON_TOKEN;
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  const argv = [process.execPath, cli, '--backend-url', options.backendUrl, '--sandbox-id', options.sandboxId,
    '--user-id', options.userId, '--workspace', options.workspace, '--sandbox', 'none', '--allow-host-agent-execution',
    '--local-permission-policy', options.localPermissionPolicy, ...(runtimeProfile ? ['--runtime-profile', runtimeProfile] : [])];
  const binDir = join(homedir(), '.local', 'bin');
  const wrapper = installLauncher(binDir, `${brand.command}-daemon`, cli, brand);
  const control = installLauncher(binDir, brand.command, join(dirname(cli), 'control.js'), brand);
  if (options.foreground) {
    // Keep service files for `relay start`, but prevent a background daemon from sharing this identity.
    const runner = serviceRunner();
    for (const computer of installed) {
      if (computer.id === options.sandboxId || sameComputer(computer, options.backendUrl, options.workspace)) {
        stopService(process.platform, process.getuid?.() ?? 0, computer, runner);
      }
    }
    console.log(`Starting ${brand.product} in this terminal. Press Ctrl+C to stop.`);
    const child = spawnSync(argv[0]!, argv.slice(1), { stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
    return;
  }
  const logDir = join(stateDir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const path = [dirname(process.execPath), process.env.PATH ?? '/usr/bin:/bin'].join(delimiter);
  const service = serviceDefinition(process.platform, options.sandboxId, argv, logDir, path, brand);
  if (process.platform === 'darwin') {
    const directory = join(homedir(), 'Library', 'LaunchAgents');
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${service.name}.plist`);
    writeFileSync(file, service.content, { mode: 0o600 });
    const domain = `gui/${process.getuid!()}`;
    if (!bootoutLaunchdService(serviceRunner(), `${domain}/${service.name}`)) {
      throw new Error(`The running ${brand.product} service ${service.name} did not stop; run the installer again.`);
    }
    // Reconnecting overrides an earlier `relay stop`, which disables the label.
    spawnSync('launchctl', ['enable', `${domain}/${service.name}`], { stdio: 'ignore' });
    execFileSync('launchctl', ['bootstrap', domain, file], { stdio: 'inherit' });
    if (options.verbose) {
      console.log(`Logs: ${join(logDir, 'service.log')}`);
    }
  } else if (process.platform === 'win32') {
    const directory = windowsServiceDirectory(homedir());
    mkdirSync(directory, { recursive: true });
    const file = join(directory, `${service.name}.xml`);
    writeFileSync(file, encodeTaskFile(service.content));
    registerWindowsTask(serviceRunner(), service.name, file);
    if (options.verbose) {
      console.log(`Logs: ${join(logDir, 'service.log')}`);
    }
  } else {
    const directory = join(homedir(), '.config', 'systemd', 'user');
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, `${service.name}.service`), service.content, { mode: 0o600 });
    execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'enable', `${service.name}.service`], { stdio: 'inherit' });
    execFileSync('systemctl', ['--user', 'restart', `${service.name}.service`], { stdio: 'inherit' });
    if (options.verbose) {
      console.log(`Logs: journalctl --user -u ${service.name}`);
    }
  }
  // Only after the new service started, so a failed install never leaves the computer with none.
  removeSupersededServices(installed, options, brand);
  console.log(`Connected to ${brand.product}. You can close this terminal.`);
  console.log(`${brand.product} runs in the background and starts automatically when you log in.`);
  if (control) {
    const relay = controlCommand(control);
    console.log(`Control ${brand.product} with:`);
    console.log(`  Stop: ${relay} stop`);
    console.log(`  Start: ${relay} start`);
    console.log('Other commands: status, restart, logs.');
  }
  if (options.verbose) console.log(`CLI installed at ${wrapper ?? join(binDir, `${brand.command}-daemon`)}.`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  install().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
