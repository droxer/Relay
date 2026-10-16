import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { serviceDefinition } from '../src/install.js';
import { bootoutLaunchdService, installedComputers, removeService, sameComputer, serviceArguments } from '../src/installed-computers.js';

const argv = ['/a path/node', '/relay/cli.js', '--backend-url', 'https://relay.example.com', '--user-id', 'alice',
  '--workspace', `/tmp/" & % $(touch x) 'w'`, '--sandbox', 'none'];

function fixture(platform: 'darwin' | 'linux') {
  const home = mkdtempSync(join(tmpdir(), 'relay-installed-test-'));
  const directory = platform === 'darwin' ? join(home, 'Library/LaunchAgents') : join(home, '.config/systemd/user');
  mkdirSync(directory, { recursive: true });
  const write = (id: string, args: string[]) => {
    const service = serviceDefinition(platform, id, args, '/tmp/log', '/usr/bin');
    const file = join(directory, `${service.name}${platform === 'darwin' ? '.plist' : '.service'}`);
    writeFileSync(file, service.content);
    return file;
  };
  return { home, write, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe('installed computers', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    it(`reads back the exact argv the ${platform} service runs`, () => {
      assert.deepEqual(serviceArguments(platform, serviceDefinition(platform, 'node-1', argv, '/tmp/log', '/usr/bin').content), argv);
    });

    it(`still lists a ${platform} computer installed with the pre-rename --employee-id flag`, () => {
      const { home, write, cleanup } = fixture(platform);
      try {
        write('node-a', argv.map(arg => (arg === '--user-id' ? '--employee-id' : arg)));
        assert.deepEqual(installedComputers(platform, home).map(computer => computer.userId), ['alice']);
      } finally {
        cleanup();
      }
    });

    it(`lists ${platform} computers by backend, user and workspace`, () => {
      const { home, write, cleanup } = fixture(platform);
      try {
        write('node-a', argv);
        write('node-b', argv.slice(0, 2));
        const computers = installedComputers(platform, home);
        assert.deepEqual(computers.map(computer => [computer.id, computer.userId, computer.workspace]), [['node-a', 'alice', argv[7]]]);
        assert.equal(sameComputer(computers[0]!, 'https://relay.example.com/', argv[7]!), true);
        assert.equal(sameComputer(computers[0]!, 'https://other.example.com', argv[7]!), false);
        assert.equal(sameComputer(computers[0]!, 'https://relay.example.com', '/tmp/other'), false);
      } finally { cleanup(); }
    });

    for (const failure of ['stop', 'still-running', 'probe-error'] as const) {
      it(`preserves a ${platform} service when ${failure} prevents confirming shutdown`, () => {
        const { home, write, cleanup } = fixture(platform);
        try {
          const file = write('node-old', argv);
          const runner = { run: (_command: string, args: string[]) => {
            const probe = args.includes('print') || args.includes('is-active');
            if (probe) return failure === 'still-running'
              ? { status: 0, stdout: 'active' } : { status: null, stdout: '' };
            return { status: failure === 'stop' ? 1 : 0, stdout: '' };
          }, sleep: () => {} };
          assert.throws(() => removeService(platform, 501, installedComputers(platform, home)[0]!, runner), /Cannot stop/);
          assert.equal(existsSync(file), true);
        } finally { cleanup(); }
      });
    }

    if (platform === 'darwin') {
      it('waits for launchd to unload a booted-out service before reporting it gone', () => {
        const calls: string[] = [];
        let probes = 0;
        const unloaded = bootoutLaunchdService({
          run: (_command, args) => { calls.push(args[0]!); return { status: args[0] === 'print' && ++probes > 2 ? 113 : 0, stdout: '' }; },
          sleep: () => { calls.push('sleep'); },
        }, 'gui/501/build.relay.computer.node-old');
        assert.equal(unloaded, true);
        assert.deepEqual(calls, ['bootout', 'print', 'sleep', 'print', 'sleep', 'print']);
      });

      for (const grace of [undefined, '60000', 'invalid', '-1', 'Infinity']) {
        it(`allows shutdown grace plus cleanup before timing out (grace=${grace})`, () => {
          const previous = process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS;
          if (grace === undefined) delete process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS;
          else process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS = grace;
          try {
            const shutdownMs = grace === '60000' ? 60_250 : 10_250;
            let elapsed = 0;
            const unloaded = bootoutLaunchdService({
              run: (_command, args) => ({ status: args[0] === 'print' && elapsed >= shutdownMs ? 113 : 0, stdout: '' }),
              sleep: ms => { elapsed += ms; },
            }, 'gui/501/x');
            assert.equal(unloaded, true);

            elapsed = 0;
            assert.equal(bootoutLaunchdService({
              run: () => ({ status: 0, stdout: '' }),
              sleep: ms => { elapsed += ms; },
            }, 'gui/501/x'), false);
            assert.equal(elapsed, (grace === '60000' ? 60_000 : 10_000) + 30_000);
          } finally {
            if (previous === undefined) delete process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS;
            else process.env.RELAY_DAEMON_SHUTDOWN_GRACE_MS = previous;
          }
        });
      }

      it('removes an already unloaded service even when bootout fails', () => {
        const { home, write, cleanup } = fixture(platform);
        try {
          const file = write('node-old', argv);
          removeService(platform, 501, installedComputers(platform, home)[0]!, {
            run: (_command, args) => ({ status: args.includes('print') ? 113 : args.includes('bootout') ? 1 : 0, stdout: '' }),
          });
          assert.equal(existsSync(file), false);
        } finally { cleanup(); }
      });
    }

    it(`stops and deletes a superseded ${platform} service`, () => {
      const { home, write, cleanup } = fixture(platform);
      try {
        const file = write('node-old', argv);
        const calls: string[] = [];
        removeService(platform, 501, installedComputers(platform, home)[0]!, { run: (command, args) => { calls.push([command, ...args].join(' ')); return { status: args.includes('print') ? 113 : args.includes('is-active') ? 3 : 0, stdout: args.includes('is-active') ? 'inactive\n' : '' }; } });
        assert.equal(existsSync(file), false);
        assert.deepEqual(calls, platform === 'darwin' ? [
          'launchctl disable gui/501/build.relay.computer.node-old',
          'launchctl bootout gui/501/build.relay.computer.node-old',
          'launchctl print gui/501/build.relay.computer.node-old',
        ] : [
          'systemctl --user disable --now build.relay.computer.node-old.service',
          'systemctl --user is-active build.relay.computer.node-old.service']);
      } finally { cleanup(); }
    });
  }
});
