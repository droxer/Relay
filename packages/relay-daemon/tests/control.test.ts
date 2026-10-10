import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { installedServices, parseControlArgs, runControl, type CommandResult, type ControlDeps } from '../src/control.js';

type Responder = (command: string, args: string[]) => CommandResult;

function fixture(platform: 'darwin' | 'linux', ids: string[], respond: Responder = () => ({ status: 0, stdout: '' })) {
  const home = mkdtempSync(join(tmpdir(), 'relay-control-test-'));
  const directory = platform === 'darwin' ? join(home, 'Library/LaunchAgents') : join(home, '.config/systemd/user');
  mkdirSync(directory, { recursive: true });
  for (const id of ids) writeFileSync(join(directory, `build.relay.computer.${id}${platform === 'darwin' ? '.plist' : '.service'}`), '');
  writeFileSync(join(directory, platform === 'darwin' ? 'com.other.agent.plist' : 'other.service'), '');
  const calls: string[] = [];
  const lines: string[] = [];
  const deps: ControlDeps = {
    platform, home, uid: 501,
    run: (command, args) => { calls.push([command, ...args].join(' ')); return respond(command, args); },
    log: line => { lines.push(line); },
  };
  return { home, deps, calls, lines, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('relay control CLI', () => {
  it('parses commands and rejects unknown input', () => {
    assert.deepEqual(parseControlArgs([]), { command: 'help', follow: false });
    assert.deepEqual(parseControlArgs(['logs', '-f', '--computer', 'node-1']), { command: 'logs', follow: true, computer: 'node-1' });
    assert.throws(() => parseControlArgs(['start', 'stop']), /Unknown argument/);
    assert.throws(() => parseControlArgs(['--computer']), /requires/);
  });

  it('finds only Relay services', () => {
    const { home, cleanup } = fixture('darwin', ['node-b', 'node-a']);
    try {
      assert.deepEqual(installedServices('darwin', home).map(service => service.id), ['node-a', 'node-b']);
    } finally { cleanup(); }
  });

  it('stops a macOS service so login does not start it, and start undoes that', () => {
    const { deps, calls, lines, cleanup } = fixture('darwin', ['node-1'], (_command, args) =>
      args[0] === 'print' ? { status: 113, stdout: '' } : { status: 0, stdout: '' });
    try {
      assert.equal(runControl(['stop'], deps), 0);
      assert.deepEqual(calls.slice(0, 2), ['launchctl disable gui/501/build.relay.computer.node-1', 'launchctl bootout gui/501/build.relay.computer.node-1']);
      assert.match(lines[0]!, /Relay stopped/);
      calls.length = 0;
      assert.equal(runControl(['start'], deps), 0);
      assert.equal(calls[0], 'launchctl enable gui/501/build.relay.computer.node-1');
      assert.match(calls[1]!, /^launchctl bootstrap gui\/501 .*build\.relay\.computer\.node-1\.plist$/);
      assert.equal(calls[2], 'launchctl kickstart gui/501/build.relay.computer.node-1');
      calls.length = 0;
      runControl(['restart'], deps);
      assert.equal(calls[2], 'launchctl kickstart -k gui/501/build.relay.computer.node-1');
    } finally { cleanup(); }
  });

  it('reports macOS status from launchd', () => {
    const { deps, lines, cleanup } = fixture('darwin', ['node-1'], () => ({ status: 0, stdout: '\tstate = running\n\tpid = 4242\n' }));
    try {
      assert.equal(runControl(['status'], deps), 0);
      assert.deepEqual(lines, ['Relay is running (pid 4242).']);
    } finally { cleanup(); }
  });

  it('uses systemd enable/disable on Linux and fails when systemd refuses', () => {
    const { deps, calls, lines, cleanup } = fixture('linux', ['node-1'], (_command, args) =>
      args[1] === 'start' ? { status: 1, stdout: '' } : { status: 0, stdout: 'inactive\n' });
    try {
      assert.equal(runControl(['stop'], deps), 0);
      assert.equal(calls[0], 'systemctl --user disable --now build.relay.computer.node-1.service');
      assert.equal(runControl(['status'], deps), 0);
      assert.equal(lines.at(-1), 'Relay is stopped.');
      assert.equal(runControl(['start'], deps), 1);
      assert.match(lines.at(-1)!, /could not be started/);
    } finally { cleanup(); }
  });

  it('labels each computer when several are installed and narrows with --computer', () => {
    const { deps, lines, calls, cleanup } = fixture('linux', ['node-1', 'node-2'], () => ({ status: 0, stdout: 'active\n' }));
    try {
      runControl(['status'], deps);
      assert.deepEqual(lines, ['node-1: Relay is running.', 'node-2: Relay is running.']);
      assert.throws(() => runControl(['logs'], deps), /--computer/);
      calls.length = 0;
      runControl(['stop', '--computer', 'node-2'], deps);
      assert.deepEqual(calls, ['systemctl --user disable --now build.relay.computer.node-2.service']);
      assert.throws(() => runControl(['stop', '--computer', 'node-3'], deps), /Installed: node-1, node-2/);
    } finally { cleanup(); }
  });

  it('explains when nothing is installed', () => {
    const { deps, cleanup } = fixture('darwin', []);
    try {
      assert.throws(() => runControl(['start'], deps), /not installed/);
      assert.equal(runControl(['--help'], deps), 0);
    } finally { cleanup(); }
  });
});
