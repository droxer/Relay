import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseInstallArgs, serviceDefinition } from '../src/install.js';

const args = ['--backend-url', 'https://relay.example.com', '--sandbox-id', 'node-1', '--employee-id', 'alice', '--workspace', '/tmp/a project'];
test('installer requires scoped settings and rejects unsupported origins and identifiers', () => {
  assert.equal(parseInstallArgs(args).workspace, '/tmp/a project');
  assert.equal(parseInstallArgs(args).verbose, false);
  assert.equal(parseInstallArgs([...args, '--verbose']).verbose, true);
  assert.throws(() => parseInstallArgs(args.slice(0, -2)), /workspace/);
  assert.throws(() => parseInstallArgs([...args, '--token', 'secret']), /Unknown/);
  assert.throws(() => parseInstallArgs(args.map(x => x === 'node-1' ? '../bad' : x)), /sandbox-id/);
  assert.throws(() => parseInstallArgs(args.map(x => x === 'https://relay.example.com' ? 'http://public.example.com' : x)), /HTTPS/);
});
test('services preserve argv boundaries and never contain node credentials', () => {
  const command = ['/a path/node', '/a path/cli.js', '--workspace', '/tmp/" & % $(touch x)'];
  const mac = serviceDefinition('darwin', 'node-1', command, '/a & b/log', '/usr/bin:/a path');
  assert.match(mac.content, /&amp;/);
  assert.match(mac.content, /&quot;/);
  assert.match(mac.content, /<key>RunAtLoad<\/key><true\/>/);
  const linux = serviceDefinition('linux', 'node-1', command, '/tmp/log', '/usr/bin');
  assert.match(linux.content, /%%/);
  assert.match(linux.content, /\$\$\(touch x\)/);
  assert.doesNotMatch(mac.content + linux.content, /TOKEN/);
});

test('installed services restart failures but leave deleted-node clean exits stopped', () => {
  const command = ['/usr/bin/node', '/relay/cli.js'];
  const mac = serviceDefinition('darwin', 'node-1', command, '/tmp/log', '/usr/bin');
  assert.match(mac.content, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  const linux = serviceDefinition('linux', 'node-1', command, '/tmp/log', '/usr/bin');
  assert.match(linux.content, /^Restart=on-failure$/m);
});

import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
test('installer verifies authentication and writes a service using the real packaged client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-install-test-'));
  const home = join(root, 'home with spaces');
  const bin = join(root, 'bin');
  const workspace = join(root, 'workspace with spaces');
  for (const path of [home, bin, workspace]) mkdirSync(path, { recursive: true });
  const customHome = join(root, 'custom codex');
  mkdirSync(customHome);
  writeFileSync(join(bin, 'codex'), '#!/bin/sh\nprintf "%s" "$CODEX_HOME" > "$CODEX_HOME/observed"\n', { mode: 0o755 });
  const calls = join(root, 'service-calls');
  for (const name of ['launchctl', 'systemctl']) {
    const file = join(bin, name);
    writeFileSync(file, '#!/bin/sh\nprintf "%s\\n" "$@" >> "$SERVICE_CALLS"\n');
    chmodSync(file, 0o755);
  }
  const registrations: Record<string, unknown>[] = [];
  let deleted = false;
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', data => { body += data; });
    request.on('end', () => {
      if (request.url === '/api/v1/daemon-node-registrations') registrations.push(JSON.parse(body));
      response.setHeader('Content-Type', 'application/json');
      response.statusCode = deleted ? 410 : 200;
      response.end(deleted ? JSON.stringify({ detail: 'Daemon node was deleted in the control panel.' }) : JSON.stringify({ sandboxId: 'node-install-test', authenticated: true }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const command = [resolve('packages/relay-daemon/dist/install.js'),
      '--backend-url', `http://127.0.0.1:${address.port}`, '--sandbox-id', 'node-install-test',
      '--employee-id', 'alice', '--workspace', workspace];
    const { stdout, stderr } = await exec(process.execPath, command, {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SERVICE_CALLS: calls, CODEX_HOME: customHome, RELAY_DAEMON_NODE_TOKEN: 'fixture-token', RELAY_DAEMON_STATE_DIR: join(root, 'unrelated-state') },
      timeout: 30_000,
    });
    assert.equal(registrations.length, 0);
    assert.doesNotMatch(stdout + stderr, /fixture-token/);
    assert.match(stdout, /Connected to Relay\. You can close this terminal\./);
    assert.doesNotMatch(stdout, /launchctl|systemctl|journalctl|CLI installed at|Logs:/);
    const credential = join(home, '.relay/daemon-nodes/node-install-test/credentials/alice.token');
    assert.equal(readFileSync(credential, 'utf8').trim(), 'fixture-token');
    assert.equal(statSync(credential).mode & 0o777, 0o600);
    const service = process.platform === 'darwin'
      ? join(home, 'Library/LaunchAgents/build.relay.computer.node-install-test.plist')
      : join(home, '.config/systemd/user/build.relay.computer.node-install-test.service');
    const content = readFileSync(service, 'utf8');
    assert.doesNotMatch(content, /fixture-token|RELAY_DAEMON_NODE_TOKEN/);
    assert.match(content, /workspace with spaces/);
    assert.doesNotMatch(content, /unrelated-state/);
    assert.match(content, /RELAY_DAEMON_STATE_DIR/);
    assert.match(readFileSync(calls, 'utf8'), /bootstrap|restart/);
    const profile = join(home, '.relay/daemon-nodes/node-install-test/runtime-profile.json');
    assert.equal(JSON.parse(readFileSync(profile, 'utf8')).environment.CODEX_HOME, customHome);
    assert.equal(readFileSync(join(customHome, 'observed'), 'utf8'), customHome);
    assert.match(content, /--runtime-profile/);
    // Launch the actual service CLI with no terminal configuration variables.
    const diagnosed = await exec(process.execPath, [resolve('packages/relay-daemon/dist/cli.js'),
      ...command.slice(1), '--sandbox', 'none', '--allow-host-agent-execution', '--runtime-profile', profile, '--doctor'], {
      env: { HOME: home, PATH: '/usr/bin:/bin' }, timeout: 30_000,
    }).catch((error: { stdout: string; stderr: string }) => error);
    assert.match(diagnosed.stdout, /OK agent:codex/);
    assert.doesNotMatch(diagnosed.stdout + diagnosed.stderr, /fixture-token/);
    // Reconnecting the same computer replaces its service instead of creating another.
    const verbose = await exec(process.execPath, [...command, '--verbose'], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, SERVICE_CALLS: calls, CODEX_HOME: customHome, RELAY_DAEMON_NODE_TOKEN: 'fixture-token' },
      timeout: 30_000,
    });
    assert.match(verbose.stdout, /Logs:/);
    assert.match(verbose.stdout, /Stop:/);
    assert.match(verbose.stdout, /CLI installed at/);
    assert.doesNotMatch(verbose.stdout + verbose.stderr, /fixture-token/);
    assert.equal(readFileSync(service, 'utf8'), content);
    assert.equal(registrations.length, 0);

    // Exercise the actual CLI: 410 is an intentional shutdown (exit 0), not a crash.
    deleted = true;
    const stopped = await exec(process.execPath, [resolve('packages/relay-daemon/dist/cli.js'),
      ...command.slice(1), '--sandbox', 'none', '--allow-host-agent-execution'], {
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin`, RELAY_DAEMON_STATE_DIR: join(home, '.relay/daemon-nodes/node-install-test') },
      timeout: 30_000,
    });
    assert.match(stopped.stdout, /was deleted in the control panel/);
    assert.doesNotMatch(stopped.stdout + stopped.stderr, /fixture-token/);
    assert.equal(registrations.length, 1);

  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
