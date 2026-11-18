import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { promisify } from 'node:util';
import { serviceDefinition } from '../src/install.js';
import { updateInstalledService } from '../src/install-service.js';
import { RELAY_BRAND } from '../src/control.js';
import { encodeTaskFile } from '../src/windows-service.js';

const exec = promisify(execFile);
const installer = resolve('packages/relay-daemon/dist/install.js');
const control = resolve('packages/relay-daemon/dist/control.js');

async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), 'relay-update-install-'));
  const mac = process.platform === 'darwin';
  const services = join(home, mac ? 'Library/LaunchAgents' : '.config/systemd/user');
  const bin = join(home, 'bin');
  const workspace = join(home, 'work');
  const calls = join(home, 'calls');
  const launcher = join(home, '.local/bin/relay-dev');
  const oldLauncher = '#!/bin/sh\n# Managed by Relay computer installer\n# old launcher\n';
  for (const directory of [services, bin, workspace, join(home, '.local/bin')]) mkdirSync(directory, { recursive: true });
  writeFileSync(launcher, oldLauncher, { mode: 0o755 });
  writeFileSync(calls, '');
  const manager = `#!/bin/sh
printf '%s\\n' "$*" >> "$TEST_CALLS"
case "$*" in
  print-disabled*) exit 0 ;;
  print*) exit 113 ;;
  *is-active*) printf 'inactive\\n'; exit 3 ;;
  *is-enabled*) printf 'enabled\\n'; exit 0 ;;
  bootstrap*|*restart*)
    service=$(find "$TEST_SERVICES" -name '*node-a.*')
    grep -q '/old/cli.js' "$service" && exit 0
    [ "$TEST_START_RESULT" != 'fail' ] || exit 5
    attempt=$(sed -nE 's/.*--update-attempt[^a-f0-9-]+([a-f0-9-]{36}).*/\\1/p' "$service")
    if [ -n "$attempt" ] && [ "$TEST_START_RESULT" = 'register' ]; then
      touch "$HOME/.relay/daemon-nodes/node-a/update-requests/startup-$attempt/registered"
    fi
    ;;
esac
exit 0
`;
  writeFileSync(join(bin, mac ? 'launchctl' : 'systemctl'), manager, { mode: 0o755 });
  const requests: string[] = [];
  let authStatus = 200;
  const server = createServer((req, res) => {
    const path = req.url!;
    requests.push(path);
    if (path === '/install.sh') {
      res.end('#!/bin/sh\nexec "$TEST_NODE" "$TEST_INSTALLER" "$@"\n');
    } else if (path.endsWith('/auth-check')) {
      const sandboxId = path.split('/').at(-2);
      res.writeHead(authStatus, { 'Content-Type': 'application/json' }).end(JSON.stringify({ sandboxId, authenticated: authStatus === 200 }));
    } else {
      res.writeHead(path === '/api/v1/computer-authorizations' ? 503 : 200, { 'Content-Type': 'application/json' }).end('{}');
    }
  });
  t.after(() => { server.close(); rmSync(home, { recursive: true, force: true }); });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const backend = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function seed(id: string, user: string, mtime: number) {
    const state = join(home, '.relay/daemon-nodes', id);
    const credentials = join(state, 'credentials');
    mkdirSync(credentials, { recursive: true });
    writeFileSync(join(credentials, `${user}.token`), 'fixture-token', { mode: 0o600 });
    const profile = join(state, 'runtime-profile.json');
    const profileContent = JSON.stringify({ version: 1, environment: { PATH: '/previous/path' } });
    writeFileSync(profile, profileContent, { mode: 0o600 });
    const options = ['--backend-url', backend, '--workspace', workspace, '--sandbox-id', id, '--user-id', user, '--runtime-profile', profile];
    const definition = serviceDefinition(process.platform, id, [process.execPath, '/old/cli.js', ...options], join(state, 'logs'), bin);
    const file = join(services, definition.name + (mac ? '.plist' : '.service'));
    writeFileSync(file, definition.content, { mode: 0o600 });
    utimesSync(file, mtime, mtime);
    return { file, content: definition.content, state, profile, profileContent };
  }
  function update(start = 'register', legacyProfile?: string) {
    const argv = legacyProfile ? [installer, '--backend-url', backend, '--workspace', workspace, '--runtime-profile', legacyProfile]
      : [control, 'update', '--computer', 'node-a'];
    return exec(process.execPath, argv, {
      env: {
        HOME: home, PATH: `${bin}:/usr/bin:/bin`, NO_COLOR: '1', RELAY_BRAND: 'dev',
        TEST_CALLS: calls, TEST_SERVICES: services, TEST_NODE: process.execPath, TEST_INSTALLER: installer, TEST_START_RESULT: start,
      }, timeout: 30_000,
    });
  }
  return { seed, update, launcher, oldLauncher, requests, calls, rejectAuth(status: number) { authStatus = status; } };
}

const skip = process.platform !== 'darwin' && process.platform !== 'linux';
for (const legacy of [false, true]) {
  test(`${legacy ? 'a legacy update with a saved profile' : 'a targeted update'} preserves the other service for the same workspace`, { skip }, async t => {
    const setup = await fixture(t);
    const selected = setup.seed('node-a', 'alice', 1000);
    const other = setup.seed('node-b', 'bob', 2000);
    mkdirSync(join(other.state, 'executions'));
    writeFileSync(join(other.state, 'executions', 'active.json'), '{}');
    const result = await setup.update('register', legacy ? selected.profile : undefined);
    assert.match(result.stdout, /Connected to Relay Dev/);
    assert.notEqual(readFileSync(selected.file, 'utf8'), selected.content);
    assert.equal(readFileSync(other.file, 'utf8'), other.content);
    assert.doesNotMatch(readFileSync(setup.calls, 'utf8'), /node-b/);
  });
}

test('a failed replacement restores the previous service and launcher', { skip }, async t => {
  const setup = await fixture(t);
  const selected = setup.seed('node-a', 'alice', 1000);
  await assert.rejects(setup.update('fail'), /Restored the previous Relay service/);
  assert.equal(readFileSync(selected.file, 'utf8'), selected.content);
  assert.equal(readFileSync(selected.profile, 'utf8'), selected.profileContent);
  assert.equal(readFileSync(setup.launcher, 'utf8'), setup.oldLauncher);
});

test('an update auth outage or rejected credential never starts enrollment', { skip }, async t => {
  const setup = await fixture(t);
  setup.seed('node-a', 'alice', 1000);
  setup.rejectAuth(503);
  await assert.rejects(setup.update(), /503/);
  assert.equal(setup.requests.includes('/api/v1/computer-authorizations'), false);
  setup.rejectAuth(401);
  await assert.rejects(setup.update(), /reconnect|install command/i);
  assert.equal(setup.requests.includes('/api/v1/computer-authorizations'), false);
});

test('Windows rollback re-registers and starts the old task when the replacement fails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-update-task-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = { id: 'node-a', name: 'build.relay.computer.node-a', file: join(root, 'task.xml') };
  const original = encodeTaskFile('<Task>old release</Task>');
  writeFileSync(service.file, original);
  let running = true;
  const starts: Buffer[] = [];
  await assert.rejects(updateInstalledService({
    platform: 'win32', uid: 0, service, brand: RELAY_BRAND, stateDir: root,
    definition: () => '<Task>new release</Task>',
    runner: {
      run(command, args) {
        if (command === 'powershell.exe') return { status: 0, stdout: running ? 'Running' : 'Ready' };
        if (args[0] === '/End') running = false;
        if (args[0] === '/Run') {
          const contents = readFileSync(service.file);
          starts.push(contents);
          running = original.equals(contents);
          return { status: running ? 0 : 1, stdout: '' };
        }
        return { status: 0, stdout: '' };
      },
    },
  }), /Restored the previous Relay service/);
  assert.deepEqual(starts, [encodeTaskFile('<Task>new release</Task>'), original]);
  assert.equal(running, true);
});

test('systemd rolls back a replacement that starts but never registers', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-update-unit-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const service = { id: 'node-a', name: 'build.relay.computer.node-a', file: join(root, 'node-a.service') };
  writeFileSync(service.file, 'old release');
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', () => timeout(5));
  let running = true;
  const starts: string[] = [];
  await assert.rejects(updateInstalledService({
    platform: 'linux', uid: 0, service, brand: RELAY_BRAND, stateDir: root,
    definition: () => 'new release',
    runner: {
      run(_command, args) {
        if (args[1] === 'is-active') return { status: running ? 0 : 3, stdout: running ? 'active' : 'inactive' };
        if (args[1] === 'is-enabled') return { status: 0, stdout: 'enabled' };
        if (args.includes('--now')) running = false;
        if (args[1] === 'restart') {
          starts.push(readFileSync(service.file, 'utf8'));
          running = true;
        }
        return { status: 0, stdout: '' };
      },
    },
  }), /did not register.*Restored the previous Relay service/);
  assert.deepEqual(starts, ['new release', 'old release']);
  assert.equal(running, true);
});
