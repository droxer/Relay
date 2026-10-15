import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, it } from 'node:test';
import { serviceDefinition } from '../src/install.js';
import { runControl, type CommandResult, type ControlDeps } from '../src/control.js';
import { installerArguments, pendingRunCount, updateCommand } from '../src/update.js';
import { acknowledgeUpdatePause, requestUpdatePause } from '../src/update-pause.js';

const run = promisify(execFile);

function serviceArgv(extra: string[] = []): string[] {
  return ['/usr/bin/node', '/relay/cli.js', '--backend-url', 'https://api.example.test', '--sandbox-id', 'node-1',
    '--user-id', 'u-1', '--workspace', '/home/me/work dir', '--sandbox', 'none', '--allow-host-agent-execution',
    '--local-permission-policy', 'trusted', ...extra];
}

async function withInstaller(body: string, status: number, test: (backend: string) => Promise<void>): Promise<void> {
  const server = createServer((_request, response) => { response.statusCode = status; response.end(body); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    await test(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally { server.close(); }
}

describe('relay update', () => {
  it('carries the backend, workspace and permission policy but never the computer id', () => {
    assert.deepEqual(installerArguments(serviceArgv()), [
      '--backend-url', 'https://api.example.test', '--workspace', '/home/me/work dir', '--local-permission-policy', 'trusted',
    ]);
  });

  it('carries the complete saved runtime profile and rejects missing or invalid profiles', () => {
    const dir = mkdtempSync(join(tmpdir(), 'relay-update-test-'));
    try {
      const profile = join(dir, 'runtime-profile.json');
      writeFileSync(profile, JSON.stringify({ version: 1, environment: { CODEX_HOME: '/saved/codex', PATH: '/saved/bin' } }), { mode: 0o600 });
      assert.deepEqual(installerArguments(serviceArgv(['--runtime-profile', profile])).slice(-2), ['--runtime-profile', profile]);
      writeFileSync(profile, 'invalid private data');
      assert.throws(() => installerArguments(serviceArgv(['--runtime-profile', profile])), /Invalid runtime configuration/);
      rmSync(profile);
      assert.throws(() => installerArguments(serviceArgv(['--runtime-profile', profile])));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('refuses a service that does not record its workspace', () => {
    assert.throws(() => installerArguments(['/usr/bin/node', '/relay/cli.js', '--backend-url', 'https://api.example.test']), /install command/);
  });

  it('builds a PowerShell invocation of install.ps1 with quoted arguments', () => {
    const argv = serviceArgv().map(arg => arg === '/home/me/work dir' ? "C:\\Users\\O'Neil\\work" : arg);
    const { command, args } = updateCommand('win32', argv);
    assert.equal(command, 'powershell.exe');
    const script = args.at(-1)!;
    assert.match(script, /irm 'https:\/\/api\.example\.test\/install\.ps1'/);
    assert.match(script, /'--workspace' 'C:\\Users\\O''Neil\\work'/);
  });

  it('pipes the backend install.sh to bash with the arguments intact', async () => {
    await withInstaller('#!/bin/sh\nfor arg in "$@"; do printf "[%s]\\n" "$arg"; done\n', 200, async backend => {
      const { command, args } = updateCommand('linux', serviceArgv().map(arg => arg === 'https://api.example.test' ? backend : arg));
      const { stdout } = await run(command, args);
      assert.equal(stdout, `[--backend-url]\n[${backend}]\n[--workspace]\n[/home/me/work dir]\n[--local-permission-policy]\n[trusted]\n`);
    });
  });

  it('fails when the installer cannot be downloaded', async () => {
    await withInstaller('', 404, async backend => {
      const { command, args } = updateCommand('linux', serviceArgv().map(arg => arg === 'https://api.example.test' ? backend : arg));
      await assert.rejects(run(command, args));
    });
  });

  it('runs the installer from relay, and refuses while runs are in flight unless forced', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-update-control-'));
    try {
      const directory = join(home, '.config/systemd/user');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'build.relay.computer.node-1.service'), serviceDefinition('linux', 'node-1', serviceArgv(), '/tmp/log', '/usr/bin').content);
      const calls: Array<{ command: string; args: string[]; inherit?: boolean }> = [];
      const lines: string[] = [];
      let status = 0;
      const deps: ControlDeps = {
        platform: 'linux', home, uid: 501,
        run: (command, args, options): CommandResult => { calls.push({ command, args, inherit: options?.inherit }); return { status, stdout: command === 'systemctl' ? 'inactive' : '' }; },
        log: line => { lines.push(line); },
      };
      assert.equal(runControl(['update'], deps), 0);
      const install = calls.find(call => call.command === 'bash')!;
      assert.equal(install.inherit, true);
      assert.equal(install.args[2], 'https://api.example.test/install.sh');
      assert.ok(!install.args.includes('--sandbox-id'));

      const executions = join(home, '.relay/daemon-nodes/node-1/executions');
      mkdirSync(executions, { recursive: true });
      writeFileSync(join(executions, 'abc.json'), '{}');
      assert.equal(pendingRunCount(home, 'node-1'), 1);
      calls.length = 0;
      assert.throws(() => runControl(['update'], deps), /runs in progress \(node-1: 1\).*--force/);
      assert.equal(calls.length, 0);
      status = 1;
      assert.equal(runControl(['update', '--force'], deps), 1);
      assert.match(lines.at(-1)!, /could not be updated/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('waits for admission to pause, rechecks late runs, and resumes after failures', () => {
    const home = mkdtempSync(join(tmpdir(), 'relay-update-pause-'));
    const stateDir = join(home, '.relay/daemon-nodes/node-1');
    try {
      const directory = join(home, '.config/systemd/user');
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'build.relay.computer.node-1.service'), serviceDefinition('linux', 'node-1', serviceArgv(), join(stateDir, 'logs'), '/usr/bin').content);
      let lateRun = true;
      let installs = 0;
      const deps: ControlDeps = {
        platform: 'linux', home, uid: 501, log: () => {},
        sleep: () => {
          if (lateRun) {
            mkdirSync(join(stateDir, 'executions'), { recursive: true });
            writeFileSync(join(stateDir, 'executions/late.json'), '{}');
          }
          assert.equal(acknowledgeUpdatePause(stateDir), true);
        },
        run: command => {
          if (command === 'systemctl') return { status: 0, stdout: 'active' };
          installs++;
          assert.equal(acknowledgeUpdatePause(stateDir), true);
          return { status: 1, stdout: '' };
        },
      };
      assert.throws(() => runControl(['update'], deps), /runs in progress/);
      assert.equal(installs, 0);
      assert.equal(acknowledgeUpdatePause(stateDir), false);
      rmSync(join(stateDir, 'executions/late.json'));
      lateRun = false;
      assert.equal(runControl(['update'], deps), 1);
      assert.equal(installs, 1);
      assert.equal(acknowledgeUpdatePause(stateDir), false);
      assert.deepEqual(readdirSync(join(stateDir, 'update-requests')), []);
      const previousRun = deps.run;
      deps.run = (command, args, options) => {
        if (command !== 'systemctl') throw new Error('installer launch failed');
        return previousRun(command, args, options);
      };
      assert.throws(() => runControl(['update'], deps), /installer launch failed/);
      assert.equal(acknowledgeUpdatePause(stateDir), false);
      deps.run = previousRun;
      deps.sleep = () => {};
      assert.throws(() => runControl(['update'], deps), /pause.*admission/i);
      assert.equal(installs, 1);
      assert.equal(acknowledgeUpdatePause(stateDir), false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('rejects concurrent updaters without releasing the first admission pause', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-update-owner-'));
    try {
      const first = requestUpdatePause(stateDir);
      assert.throws(() => requestUpdatePause(stateDir), /already in progress/);
      assert.equal(acknowledgeUpdatePause(stateDir), true);
      assert.equal(first.acknowledged(), true);
      first.release();
      assert.equal(acknowledgeUpdatePause(stateDir), false);
      const next = requestUpdatePause(stateDir);
      assert.equal(next.acknowledged(), false);
      next.release();
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });

  it('ignores abandoned update requests after the updater exits', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'relay-update-abandoned-'));
    try {
      // Obtain a real exited PID instead of assuming some arbitrary PID is unused.
      const { stdout } = await run(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']);
      const directory = join(stateDir, 'update-requests');
      mkdirSync(directory);
      writeFileSync(join(directory, 'abandoned.json'), JSON.stringify({ pid: Number(stdout), nonce: '00000000-0000-0000-0000-000000000000' }));
      assert.equal(acknowledgeUpdatePause(stateDir), false);
      const next = requestUpdatePause(stateDir);
      assert.equal(acknowledgeUpdatePause(stateDir), true);
      assert.equal(next.acknowledged(), true);
      next.release();
      assert.equal(acknowledgeUpdatePause(stateDir), false);
    } finally { rmSync(stateDir, { recursive: true, force: true }); }
  });
});
