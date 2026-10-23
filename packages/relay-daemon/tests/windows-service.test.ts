import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { RELAY_DEV_BRAND, runControl, type CommandResult, type ControlDeps } from '../src/control.js';
import { launcherScript, serviceDefinition } from '../src/install.js';
import { installedComputers, removeService, serviceArguments } from '../src/installed-computers.js';
import { decodeServiceFile, encodeTaskFile, registerWindowsTask, windowsAccount, windowsServiceDirectory } from '../src/windows-service.js';

const argv = ['C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\o\'brien\\AppData\\Local\\Relay\\releases\\abc\\node_modules\\relay-daemon\\dist\\cli.js',
  '--backend-url', 'https://relay.example.com', '--sandbox-id', 'node-1', '--user-id', 'alice',
  '--workspace', 'C:\\Users\\o\'brien\\My Work & $(stuff) "x"', '--sandbox', 'none'];

function decodedScript(content: string): string {
  const encoded = /-EncodedCommand (\S+)<\/Arguments>/.exec(content)![1]!;
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

describe('Windows service', () => {
  it('registers a hidden logon task for the installing account only', () => {
    const task = serviceDefinition('win32', 'node-1', argv, 'C:\\state\\logs', 'C:\\node;C:\\Windows', undefined, 'CORP\\alice');
    assert.equal(task.name, 'build.relay.computer.node-1');
    assert.match(task.content, /<LogonTrigger><Enabled>true<\/Enabled><UserId>CORP\\alice<\/UserId><\/LogonTrigger>/);
    assert.match(task.content, /<LogonType>InteractiveToken<\/LogonType><RunLevel>LeastPrivilege<\/RunLevel>/);
    assert.match(task.content, /-WindowStyle Hidden -EncodedCommand /);
    assert.match(task.content, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
    assert.doesNotMatch(task.content + decodedScript(task.content), /TOKEN/);
  });

  it('runs the daemon through the service host, which owns the log and restarts', () => {
    const script = decodedScript(serviceDefinition('win32', 'node-1', argv, 'C:\\state\\logs', 'C:\\a;C:\\b', undefined, 'alice').content);
    assert.match(script, /^\$env:PATH = 'C:\\a;C:\\b'$/m);
    assert.match(script, /^& 'C:\\Program Files\\nodejs\\node\.exe' '[^']*windows-service-host\.js' '[^']*service\.log' 'C:\\Program Files\\nodejs\\node\.exe' /m);
    assert.match(script, /^exit \$LASTEXITCODE$/m);
  });

  it('reads back the exact daemon argv, quotes and all', () => {
    const task = serviceDefinition('win32', 'node-1', argv, 'C:\\state\\logs', 'C:\\x', undefined, 'alice');
    assert.deepEqual(serviceArguments('win32', task.content), argv);
    assert.equal(decodeServiceFile(encodeTaskFile(task.content)), task.content);
    assert.deepEqual(serviceArguments('win32', '<Task/>'), []);
  });

  it('names the account as DOMAIN\\user when a domain is known', () => {
    assert.equal(windowsAccount({ USERDOMAIN: 'CORP', USERNAME: 'alice' }), 'CORP\\alice');
    assert.equal(windowsAccount({ USERNAME: 'alice' }), 'alice');
  });

  it('writes batch launchers on Windows and shell launchers elsewhere', () => {
    assert.equal(launcherScript('win32', 'C:\\node.exe', 'C:\\r\\control.js'),
      '@echo off\r\nrem # Managed by Relay computer installer\r\nsetlocal\r\n"C:\\node.exe" "C:\\r\\control.js" %*\r\n');
    assert.match(launcherScript('win32', 'C:\\node.exe', 'C:\\r\\control.js', RELAY_DEV_BRAND), /\r\nset RELAY_BRAND=dev\r\n/);
    assert.match(launcherScript('win32', 'C:\\100%\\node.exe', 'C:\\c.js'), /"C:\\100%%\\node\.exe"/);
    assert.match(launcherScript('darwin', '/n', '/c.js'), /^#!\/bin\/sh\n/);
  });
});

function windowsFixture(respond: (command: string, args: string[]) => CommandResult = () => ({ status: 0, stdout: '' })) {
  const home = mkdtempSync(join(tmpdir(), 'relay-windows-test-'));
  const directory = windowsServiceDirectory(home);
  mkdirSync(directory, { recursive: true });
  const task = serviceDefinition('win32', 'node-1', argv, join(home, 'logs'), 'C:\\x', undefined, 'alice');
  writeFileSync(join(directory, `${task.name}.xml`), encodeTaskFile(task.content));
  writeFileSync(join(directory, 'unrelated.xml'), encodeTaskFile('<Task/>'));
  const calls: string[] = [];
  const lines: string[] = [];
  const run = (command: string, args: string[]) => { calls.push([command, ...args].join(' ')); return respond(command, args); };
  const deps: ControlDeps = { platform: 'win32', home, uid: 0, run, sleep: () => undefined, log: line => { lines.push(line); } };
  return { home, deps, calls, lines, run, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('Windows service control', () => {
  it('finds installed computers from their UTF-16 task files', () => {
    const { home, cleanup } = windowsFixture();
    try {
      const [computer, ...rest] = installedComputers('win32', home);
      assert.equal(rest.length, 0);
      assert.equal(computer!.id, 'node-1');
      assert.equal(computer!.workspace, argv[9]);
      assert.equal(computer!.backendUrl, 'https://relay.example.com');
    } finally { cleanup(); }
  });

  it('stop ends the task before disabling its logon trigger; start re-enables and runs it', () => {
    const { deps, calls, lines, cleanup } = windowsFixture((command) =>
      command === 'powershell.exe' ? { status: 0, stdout: 'Ready\r\n' } : { status: 0, stdout: '' });
    try {
      assert.equal(runControl(['stop'], deps), 0);
      assert.equal(calls[0], 'schtasks /End /TN build.relay.computer.node-1');
      assert.match(calls[1]!, /Get-ScheduledTask -TaskName 'build\.relay\.computer\.node-1'/);
      assert.equal(calls[2], 'schtasks /Change /TN build.relay.computer.node-1 /DISABLE');
      assert.match(lines[0]!, /Relay stopped/);
      calls.length = 0;
      assert.equal(runControl(['start'], deps), 0);
      assert.deepEqual(calls, ['schtasks /Change /TN build.relay.computer.node-1 /ENABLE', 'schtasks /Run /TN build.relay.computer.node-1']);
      calls.length = 0;
      runControl(['restart'], deps);
      assert.deepEqual(calls.map(call => call.split(' ')[1]), ['/Change', '/End', '-NoProfile', '/Run']);
      runControl(['status'], deps);
      assert.equal(lines.at(-1), 'Relay is stopped.');
    } finally { cleanup(); }
  });

  it('reports a running task and refuses to call a still-running task stopped', () => {
    const { deps, lines, calls, cleanup } = windowsFixture((command) =>
      command === 'powershell.exe' ? { status: 0, stdout: 'Running\r\n' } : { status: 0, stdout: '' });
    try {
      assert.equal(runControl(['status'], deps), 0);
      assert.equal(lines.at(-1), 'Relay is running.');
      assert.equal(runControl(['stop'], deps), 1);
      // A task that will not end is never disabled and reported stopped.
      assert.ok(!calls.some(call => call.includes('/DISABLE')));
    } finally { cleanup(); }
  });

  it('reinstalling ends the running instance before starting the new release', () => {
    const calls: string[] = [];
    let running = true;
    const runner = {
      sleep: () => undefined,
      run: (command: string, args: string[]) => {
        calls.push(args[0]!.startsWith('/') ? args[0]! : 'state');
        if (args[0] === '/End') running = false;
        return { status: 0, stdout: command === 'powershell.exe' ? (running ? 'Running' : 'Ready') : '' };
      },
    };
    registerWindowsTask(runner, 'build.relay.computer.node-1', 'C:\\task.xml');
    assert.deepEqual(calls, ['/Create', '/End', 'state', '/Run']);
    running = true;
    const stuck = { ...runner, run: (command: string, args: string[]) => ({ status: 0, stdout: command === 'powershell.exe' ? 'Running' : '' }) };
    assert.throws(() => registerWindowsTask(stuck, 'n', 'f'), /relay restart/);
  });

  it('follows UTF-8 logs and waits for a missing service log', () => {
    const { deps, calls, cleanup } = windowsFixture();
    try {
      assert.equal(runControl(['logs', '-f'], deps), 0);
      assert.match(calls[0]!, /while \(!\(Test-Path -LiteralPath/);
      assert.match(calls[0]!, /Get-Content -LiteralPath .* -Encoding UTF8 -Tail 100 -Wait$/);
    } finally { cleanup(); }
  });

  it('removing a superseded computer deletes its task and its definition', () => {
    const { home, run, calls, cleanup } = windowsFixture((command) =>
      command === 'powershell.exe' ? { status: 0, stdout: 'Disabled' } : { status: 0, stdout: '' });
    try {
      removeService('win32', 0, installedComputers('win32', home)[0]!, { run });
      assert.equal(calls.at(-1), 'schtasks /Delete /TN build.relay.computer.node-1 /F');
      assert.equal(installedComputers('win32', home).length, 0);
    } finally { cleanup(); }
  });
});
