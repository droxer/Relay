/**
 * Windows has no per-user service manager, so a Relay "service" there is a
 * Task Scheduler logon task for the installing account. Standard users may
 * register one when the trigger and principal name their own account with an
 * interactive token, so no elevation is needed.
 *
 * The task launches PowerShell hidden, which runs `windows-service-host.js`:
 * that host owns the log file and the restart-on-failure loop, because Task
 * Scheduler only restarts tasks that fail to launch, not ones that exit non-zero.
 */
import { join } from 'node:path';

export interface TaskRunner {
  run(command: string, args: string[], options?: { inherit?: boolean }): { status: number | null; stdout: string };
  /** Blocking pause between state polls; tests pass a no-op. */
  sleep?(ms: number): void;
}

const END_POLLS = 40;
const END_POLL_MS = 250;
const sleepSync = (ms: number): void => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

export const WINDOWS_SERVICE_SUFFIX = '.xml';
const POWERSHELL = '%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** Where the installer keeps the task definitions it registered, one file per computer. */
export function windowsServiceDirectory(home: string): string {
  return join(home, 'AppData', 'Local', 'Relay', 'services');
}

/** `DOMAIN\user` — the account the logon trigger and principal must name. */
export function windowsAccount(env: NodeJS.ProcessEnv = process.env, username = env.USERNAME ?? ''): string {
  return env.USERDOMAIN ? `${env.USERDOMAIN}\\${username}` : username;
}

const xml = (value: string): string => value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** A PowerShell single-quoted literal: nothing inside is expanded. */
export const powershellLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The service host's own argv (node, host script, log file) precedes the daemon's. */
const HOST_ARGUMENTS = 3;

export function windowsTaskDefinition(options: {
  id: string; argv: string[]; hostScript: string; logFile: string; stateDir: string; path: string; account: string; product?: string;
}): string {
  const [node, ...rest] = options.argv;
  const script = [
    `$env:PATH = ${powershellLiteral(options.path)}`,
    `$env:RELAY_DAEMON_STATE_DIR = ${powershellLiteral(options.stateDir)}`,
    `& ${[node!, options.hostScript, options.logFile, node!, ...rest].map(powershellLiteral).join(' ')}`,
    'exit $LASTEXITCODE',
  ].join('\n');
  // EncodedCommand sidesteps every layer of command-line quoting between Task Scheduler and PowerShell.
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const args = [...POWERSHELL_FLAGS, '-WindowStyle', 'Hidden', '-EncodedCommand', encoded].join(' ');
  const account = xml(options.account);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>${xml(options.product ?? 'Relay')} personal computer ${xml(options.id)}</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${account}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${account}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(POWERSHELL)}</Command><Arguments>${xml(args)}</Arguments></Exec></Actions>
</Task>
`;
}

/** Inverse of `windowsTaskDefinition`: the daemon argv the task runs. */
export function windowsTaskArguments(content: string): string[] {
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(content)?.[1]
    ?.replace(/&(lt|gt|amp|quot|apos);/g, (_, name: string) => XML_ENTITIES[name]!) ?? '';
  const encoded = /-EncodedCommand\s+(\S+)/.exec(args)?.[1];
  if (!encoded) return [];
  const script = Buffer.from(encoded, 'base64').toString('utf16le');
  const invocation = script.split('\n').find(line => line.startsWith('& '))?.slice(2) ?? '';
  const literals = [...invocation.matchAll(/'((?:[^']|'')*)'/g)].map(match => match[1]!.replace(/''/g, "'"));
  return literals.slice(HOST_ARGUMENTS);
}

/** Task definitions are written UTF-16 with a BOM, the encoding schtasks /XML reliably accepts. */
export function encodeTaskFile(content: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
}

export function decodeServiceFile(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  return bytes.toString('utf8');
}

/** Task Scheduler's state name — Running, Ready, Disabled — which, unlike schtasks text, is not localized. */
export function windowsTaskState(runner: TaskRunner, name: string): string {
  const result = runner.run('powershell.exe', [...POWERSHELL_FLAGS, '-Command', `(Get-ScheduledTask -TaskName ${powershellLiteral(name)}).State`]);
  return result.status === 0 ? result.stdout.trim() || 'Unknown' : 'Unknown';
}

/**
 * Ends a running instance and waits until Task Scheduler no longer reports one.
 * Ending kills only the hidden PowerShell; the service host sees its parent gone
 * and stops the daemon tree. The task is IgnoreNew, so a /Run issued before the
 * old instance is gone would start nothing.
 */
function endWindowsTask(runner: TaskRunner, name: string): boolean {
  // Ending a task that is not running reports an error; the state poll is the proof.
  runner.run('schtasks', ['/End', '/TN', name]);
  for (let poll = 0; poll < END_POLLS; poll++) {
    if (windowsTaskState(runner, name) !== 'Running') return true;
    (runner.sleep ?? sleepSync)(END_POLL_MS);
  }
  return false;
}

/**
 * Ends the task, then disables its logon trigger. Ending first matters: a
 * disabled task reports `Disabled` even while an instance still runs.
 */
export function stopWindowsTask(runner: TaskRunner, name: string): boolean {
  if (!endWindowsTask(runner, name)) return false;
  return runner.run('schtasks', ['/Change', '/TN', name, '/DISABLE']).status === 0;
}

export function startWindowsTask(runner: TaskRunner, name: string, restart: boolean): boolean {
  // "relay stop" disabled the task so login does not start it; undo that first.
  if (runner.run('schtasks', ['/Change', '/TN', name, '/ENABLE']).status !== 0) return false;
  if (restart && !endWindowsTask(runner, name)) return false;
  return runner.run('schtasks', ['/Run', '/TN', name]).status === 0;
}

/** Registers (or replaces) the task and restarts it, so a reinstall runs the new release now. */
export function registerWindowsTask(runner: TaskRunner, name: string, file: string): void {
  const rejected = (step: string) => new Error(`Task Scheduler rejected the Relay service (schtasks ${step}).`);
  // /F replaces an earlier registration of the same computer but leaves its running instance alone.
  if (runner.run('schtasks', ['/Create', '/TN', name, '/XML', file, '/F'], { inherit: true }).status !== 0) throw rejected('/Create');
  if (!endWindowsTask(runner, name)) throw new Error('The previous Relay service did not stop; run "relay restart" to load the new release.');
  if (runner.run('schtasks', ['/Run', '/TN', name], { inherit: true }).status !== 0) throw rejected('/Run');
}

export function deleteWindowsTask(runner: TaskRunner, name: string): void {
  runner.run('schtasks', ['/Delete', '/TN', name, '/F']);
}

export function windowsLogTail(runner: TaskRunner, file: string, lines: string, follow: boolean): boolean {
  const command = `Get-Content -LiteralPath ${powershellLiteral(file)} -Tail ${lines}${follow ? ' -Wait' : ''}`;
  return runner.run('powershell.exe', [...POWERSHELL_FLAGS, '-Command', command], { inherit: true }).status === 0;
}
