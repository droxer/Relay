import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serviceDefinition } from '../src/install.js';
import { TerminalOutbox } from '../src/terminal-outbox.js';
import { AdmissionLedger } from '../src/admission-ledger.js';
import { acquireDaemonStateLock } from '../src/daemon-state-lock.js';
import { installedServices, parseControlArgs, RELAY_DEV_BRAND, runControl, type CommandResult, type ControlDeps } from '../src/control.js';

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
  it('shows original quarantine reason and the exact recovery command for its Computer', async () => {
    const { home, deps, lines, cleanup } = fixture('darwin', ['node-1']);
    try {
      const outbox = new TerminalOutbox(join(home, '.relay', 'daemon-nodes', 'node-1', 'terminal-events'));
      await outbox.wrapFetch(async () => Response.json({ detail: 'Report ownership mismatch.' }, { status: 409 }))(
        'http://backend/events', { method: 'POST', body: JSON.stringify({ type: 'run.cancelled', commandId: 'cmd' }) });
      const [report] = outbox.summaries();
      assert.equal(runControl(['reports'], deps), 0);
      assert.match(lines.join('\n'), /Report ownership mismatch/);
      assert.ok(lines.some(line => line.includes(`retry-report --computer node-1 --report ${report.id}`)));
      assert.match(lines.join('\n'), /stop this Computer/);
      assert.match(lines.join('\n'), /discard-report --computer node-1 --all-quarantined --acknowledge-output-loss/);
    } finally { cleanup(); }
  });

  it('discards only the selected reports, audits each identity, and preserves execution fences', async () => {
    const { home, deps, lines, cleanup } = fixture('darwin', ['node-1', 'node-2'], () => ({ status: 113, stdout: '' }));
    try {
      const stateDir = join(home, '.relay', 'daemon-nodes', 'node-1');
      const directory = join(stateDir, 'terminal-events');
      const outbox = new TerminalOutbox(directory);
      const pending = outbox.retain({ type: 'run.completed', commandId: 'pending' }).key;
      const quarantined = outbox.retain({ type: 'run.cancelled', commandId: 'quarantined' }).key;
      const other = new TerminalOutbox(join(home, '.relay', 'daemon-nodes', 'node-2', 'terminal-events'));
      other.retain({ type: 'run.completed', commandId: 'other' });
      await outbox.wrapFetch(async () => new Response('Conflict', { status: 409 }))('http://backend/events', {
        method: 'POST', body: JSON.stringify({ type: 'run.cancelled', commandId: 'quarantined' }),
      });
      const discard = async (...args: string[]) => runControl(['discard-report', ...args], deps);
      const target = ['--computer', 'node-1'];
      const confirm = '--acknowledge-output-loss';
      await assert.rejects(discard('--all', confirm), /Choose one Computer/);
      await assert.rejects(discard(...target, '--all'), /acknowledge-output-loss/);
      await assert.rejects(discard(...target, '--all', '--report', pending, confirm), /Choose exactly one/);
      await assert.rejects(discard(...target, '--report', '0'.repeat(64), confirm), /Report is not retained/);
      assert.equal(new TerminalOutbox(directory).status().pending, 2);
      assert.ok(readdirSync(directory).every(name => !name.endsWith('.audit')));

      assert.equal(await discard(...target, '--all-quarantined', confirm), 0);
      assert.deepEqual(new TerminalOutbox(directory).pending().map(report => report.key), [pending]);
      assert.match(lines.join('\n'), /Discarded 1 report.*1 retained, 0 quarantined/);

      assert.equal(await discard(...target, '--report', pending, confirm), 0);
      assert.equal(await discard(...target, '--all', confirm), 0);
      assert.match(lines.join('\n'), /No reports matched/);
      assert.equal(new TerminalOutbox(directory).status().pending, 0);
      assert.equal(new TerminalOutbox(join(home, '.relay', 'daemon-nodes', 'node-2', 'terminal-events')).status().pending, 1);
      const audit = readdirSync(directory).filter(name => name.endsWith('.audit')).map(name =>
        JSON.parse(readFileSync(join(directory, name), 'utf8')));
      assert.deepEqual(audit.map(entry => entry.reportId).sort(), [pending, quarantined].sort());
      assert.ok(audit.every(entry => entry.action === 'discard-with-output-loss' && entry.actor === 'local-uid:501'));
      const ledger = new AdmissionLedger(join(stateDir, 'admissions'));
      assert.ok(ledger.has('pending'));
      assert.ok(ledger.has('quarantined'));
    } finally { cleanup(); }
  });

  it('blocks cleanup while another process owns the daemon state', async () => {
    const { home, deps, cleanup } = fixture('darwin', ['node-1'], () => ({ status: 113, stdout: '' }));
    const stateDir = join(home, '.relay', 'daemon-nodes', 'node-1');
    const directory = join(stateDir, 'terminal-events');
    const outbox = new TerminalOutbox(directory);
    outbox.retain({ type: 'run.completed', commandId: 'pending' });
    const release = await acquireDaemonStateLock(stateDir);
    try {
      await assert.rejects(async () => runControl(['discard-report', '--all', '--acknowledge-output-loss'], deps),
        /already using this daemon state directory/);
      assert.equal(new TerminalOutbox(directory).status().pending, 1);
    } finally { release(); cleanup(); }
  });

  it('clears the full queue beyond the report listing limit', async () => {
    const { home, deps, lines, cleanup } = fixture('darwin', ['node-1'], () => ({ status: 113, stdout: '' }));
    try {
      const directory = join(home, '.relay', 'daemon-nodes', 'node-1', 'terminal-events');
      const outbox = new TerminalOutbox(directory);
      for (let sequence = 0; sequence < 201; sequence++) {
        await outbox.retain({ type: 'run.output', commandId: 'cmd', sequence }).durable;
      }
      const terminal = { type: 'run.cancelled', commandId: 'cmd' };
      await outbox.wrapFetch(async () => new Response('Conflict', { status: 409 }))('http://backend/events', {
        method: 'POST', body: JSON.stringify(terminal),
      });
      assert.equal(await runControl(['discard-report', '--all', '--acknowledge-output-loss'], deps), 0);
      assert.match(lines.join('\n'), /Discarded 202 report.*0 retained, 0 quarantined/);
      assert.equal(new TerminalOutbox(directory).status().pending, 0);
      assert.equal(readdirSync(directory).filter(name => name.endsWith('.audit')).length, 202);
    } finally { cleanup(); }
  });

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

  it('waits for macOS shutdown to finish before reporting stop success', () => {
    let polls = 0;
    const { deps, lines, cleanup } = fixture('darwin', ['node-1'], (_command, args) =>
      args[0] === 'print' && ++polls < 3
        ? { status: 0, stdout: '\tstate = running\n\tpid = 4242\n' }
        : { status: args[0] === 'print' ? 113 : 0, stdout: '' });
    const waits: number[] = [];
    deps.sleep = ms => { waits.push(ms); };
    try {
      assert.equal(runControl(['stop'], deps), 0);
      assert.equal(polls, 3);
      assert.deepEqual(waits, [250, 250]);
      assert.match(lines[0]!, /Relay stopped/);
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

  it('names itself Relay Dev when launched as relay-dev', () => {
    const { home, deps, lines, cleanup } = fixture('linux', [], () => ({ status: 0, stdout: 'active\n' }));
    try {
      const argv = ['/usr/bin/node', '/relay/cli.js', '--backend-url', 'http://127.0.0.1:8790'];
      writeFileSync(join(home, '.config/systemd/user/build.relay.computer.node-1.service'), serviceDefinition('linux', 'node-1', argv, '/tmp/log', '/usr/bin').content);
      const dev = { ...deps, brand: RELAY_DEV_BRAND };
      runControl(['--help'], dev);
      assert.match(lines[0]!, /^relay-dev <command>/);
      assert.match(lines[0]!, /Control the Relay Dev service/);
      runControl(['status'], dev);
      assert.equal(lines.at(-1), 'Relay Dev is running.');
      assert.throws(() => runControl(['bogus'], dev), /Run "relay-dev --help"/);
    } finally { cleanup(); }
  });

  it('relay and relay-dev each control only the computers on their own backend', () => {
    const { home, deps, lines, cleanup } = fixture('linux', [], () => ({ status: 0, stdout: 'active\n' }));
    try {
      const directory = join(home, '.config/systemd/user');
      for (const [id, backend] of [['node-prod', 'https://api.get-relay.cc'], ['node-dev', 'http://localhost:8790']]) {
        const argv = ['/usr/bin/node', '/relay/cli.js', '--backend-url', backend!, '--sandbox-id', id!];
        writeFileSync(join(directory, `build.relay.computer.${id}.service`), serviceDefinition('linux', id!, argv, '/tmp/log', '/usr/bin').content);
      }
      runControl(['status'], deps);
      assert.deepEqual(lines, ['Relay is running.']);
      lines.length = 0;
      runControl(['status'], { ...deps, brand: RELAY_DEV_BRAND });
      assert.deepEqual(lines, ['Relay Dev is running.']);
      assert.throws(() => runControl(['stop', '--computer', 'node-prod'], { ...deps, brand: RELAY_DEV_BRAND }), /Installed: node-dev/);
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

  it('follows a macOS log even before the first service start', () => {
    const { deps, calls, cleanup } = fixture('darwin', ['node-1']);
    try {
      assert.equal(runControl(['logs', '-f'], deps), 0);
      assert.equal(calls.length, 1);
      assert.match(calls[0]!, /^tail -n 100 -F .*service\.log$/);
    } finally { cleanup(); }
  });

  it('reads recent Linux journal output and follows with the short flag', () => {
    const { deps, calls, cleanup } = fixture('linux', ['node-1']);
    try {
      assert.equal(runControl(['logs', '-f'], deps), 0);
      assert.equal(calls[0], 'journalctl --user -u build.relay.computer.node-1.service -n 100 --no-pager -f');
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

describe('relay client version', () => {
  for (const command of ['--version', '-v', 'version']) {
    it(`reports ${command} without discovering or controlling services`, async () => {
      const { RELAY_CLIENT_VERSION } = await import('../src/client-version.js');
      const { deps, calls, lines, cleanup } = fixture('linux', []);
      try {
        assert.equal(runControl([command], deps), 0);
        assert.deepEqual(lines, [`relay ${RELAY_CLIENT_VERSION}`]);
        assert.deepEqual(calls, []);
        lines.length = 0;
        assert.equal(runControl([command], { ...deps, brand: RELAY_DEV_BRAND }), 0);
        assert.deepEqual(lines, [`relay-dev ${RELAY_CLIENT_VERSION}`]);
        assert.deepEqual(calls, []);
      } finally { cleanup(); }
    });
  }
});
