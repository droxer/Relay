import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DaemonNodeRunCommand, DaemonNodeEvent } from 'relay-core';
import { RunSupervisor } from '../src/run-supervisor.js';
import { AdmissionLedger } from '../src/admission-ledger.js';
import { ExecutionJournal } from '../src/execution-journal.js';
import { ExecutionWatchdog } from '../src/execution-watchdog.js';
import { WorkspaceRunGate } from '../src/workspace-run-gate.js';

const command = (id: string, agent: 'codex' | 'claude' = 'codex') => ({
  type: 'run.start', id, runId: id, sessionId: id, leaseId: `lease-${id}`, agent,
}) as DaemonNodeRunCommand;
const done = (id: string) => ({ type: 'run.completed', commandId: id, sessionId: id, runId: id, agent: 'codex' }) as DaemonNodeEvent;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixture(t: test.TestContext, capacity = 2, root = mkdtempSync(join(tmpdir(), 'relay-supervision-'))) {
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const journal = new ExecutionJournal(join(root, 'journal'));
  const ledger = new AdmissionLedger(join(root, 'fences'));
  const reports: string[] = [];
  const supervisor = new RunSupervisor({
    journal, ledger, watchdog: new ExecutionWatchdog(), workspaceGate: new WorkspaceRunGate(root),
    maxConcurrentRuns: capacity, runtimeLimits: { codex: 1 }, leaseDurationMs: 60_000,
    logger: { info() {}, warn() {}, error() {}, output() {} }, sandboxId: 'test',
    report: async (event: DaemonNodeEvent) => { reports.push(event.type); supervisor.terminalStored(event.commandId); },
    exitUnconfirmed: async () => {}, onIdle() {},
  });
  return { supervisor, journal, ledger, reports, root };
}

test('admission fences a run before execution and rejects duplicates and saturated runtimes', async t => {
  const { supervisor, journal, ledger } = fixture(t);
  let finish!: () => void;
  let executions = 0;
  const execute = async () => { executions++; await new Promise<void>(resolve => { finish = resolve; }); return done('a'); };
  assert.equal(supervisor.accept(command('a'), 'a', execute), 'accepted');
  assert.equal(journal.has('a'), true);
  assert.equal(ledger.has('a'), true);
  assert.equal(supervisor.accept(command('a'), 'a', execute), 'duplicate');
  assert.equal(supervisor.accept(command('b'), 'b', execute), 'runtime-capacity');
  await tick();
  assert.equal(executions, 1);
  finish();
  await supervisor.settle();
  assert.equal(supervisor.accept(command('a'), 'a', execute), 'recovery-required');
});

test('workspace waiting occupies capacity and cancellation prevents execution', async t => {
  const { supervisor, root, reports } = fixture(t);
  let finish!: () => void;
  supervisor.accept(command('a'), root, async () => {
    await new Promise<void>(resolve => { finish = resolve; });
    return done('a');
  });
  await tick();
  let started = false;
  supervisor.accept(command('b', 'claude'), root, async () => { started = true; return done('b'); });
  assert.equal(supervisor.accept(command('c', 'claude'), 'other', async () => { throw Error('unexpected'); }), 'computer-capacity');
  supervisor.cancel('b', 'stop');
  await tick();
  assert.equal(started, false);
  assert.ok(reports.includes('run.cancelled'));
  finish();
  await supervisor.settle();
});

test('durable terminal handoff frees capacity before a stalled upload finishes', async t => {
  const { supervisor } = fixture(t, 1);
  supervisor.accept(command('a'), 'a', async () => {
    supervisor.terminalStored('a');
    await new Promise<void>(resolve => { t.after(() => resolve()); });
    return done('a');
  });
  await tick();
  assert.equal(supervisor.commands(true).length, 0);
  assert.equal(supervisor.accept(command('b'), 'b', async () => (done('b'))), 'accepted');
});

test('a partial admission can resume after a restart without executing twice', async t => {
  const { supervisor, journal, ledger, root } = fixture(t);
  const add = ledger.add.bind(ledger);
  ledger.add = id => { add(id); throw Error('admission write reported an error'); };
  let starts = 0;
  const execute = async () => { starts++; return done('a'); };
  assert.equal(supervisor.accept(command('a'), 'a', execute), 'admission-unavailable');
  await supervisor.settle();
  assert.equal(starts, 0);
  const { supervisor: restarted } = fixture(t, 2, root);
  assert.equal(restarted.accept({ ...command('a'), leaseId: 'another-lease' }, 'a', execute), 'recovery-required');
  assert.equal(restarted.accept(command('a'), 'a', execute), 'accepted');
  await restarted.settle();
  assert.equal(starts, 1);
  assert.equal(journal.has('a'), true);
  assert.equal(restarted.accept(command('a'), 'a', execute), 'recovery-required');
});

test('drain closes admission and cancels preparation without waiting for discovery', async t => {
  const { supervisor, reports } = fixture(t);
  let started = false;
  supervisor.accept(command('a'), 'a', async () => { started = true; return done('a'); }, undefined, new Promise(() => {}));
  await tick();
  supervisor.closeAdmission();
  supervisor.stopAll('shutdown');
  assert.equal(supervisor.accept(command('b'), 'b', async () => done('b')), 'draining');
  await supervisor.settle();
  assert.equal(started, false);
  assert.deepEqual(reports, ['run.cancelled']);
});

test('duplicate delivery refreshes the existing execution lease without restarting', async t => {
  const { supervisor } = fixture(t);
  let finish!: () => void;
  supervisor.accept(command('a'), 'a', async () => { await new Promise<void>(resolve => { finish = resolve; }); return done('a'); });
  await tick();
  const duplicate = { ...command('a'), leaseId: 'renewed', leaseExpiresAt: '2030-01-01T00:00:00Z', attempt: 2 };
  assert.equal(supervisor.accept(duplicate, 'a', async () => { throw Error('must not run'); }), 'duplicate');
  assert.equal(supervisor.commands()[0]?.leaseId, 'renewed');
  finish(); await supervisor.settle();
});

test('shutdown aborts a pending upload even after its terminal outcome is durable', async t => {
  const { supervisor } = fixture(t);
  let aborted = false;
  supervisor.accept(command('a'), 'a', async signal => {
    supervisor.terminalStored('a');
    await new Promise<void>(resolve => {
      t.after(() => resolve());
      signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true });
    });
    return done('a');
  });
  await tick();
  supervisor.stopAll('shutdown');
  assert.equal(aborted, true);
  await supervisor.settle();
});


for (const subpath of ['projects/a', 'links/repo']) {
  test(`project runs execute concurrently in ${subpath}`, async t => {
    const { supervisor, root } = fixture(t);
    const started: string[] = [];
    const waiting: unknown[] = [];
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    try {
      for (const [id, agent] of [['a', 'codex'], ['b', 'claude']] as const) {
        assert.equal(supervisor.accept(
          { ...command(id, agent), workspaceLayout: 'project', workspaceSubpath: subpath },
          join(root, subpath),
          async () => { started.push(id); await pending; return done(id); },
          async blocker => { waiting.push(blocker); },
        ), 'accepted');
      }
      await tick();
      assert.deepEqual(started, ['a', 'b']);
      assert.deepEqual(waiting, []);
      assert.equal(supervisor.accept(command('c', 'claude'), root, async () => done('c')), 'computer-capacity');
    } finally {
      release();
      await supervisor.settle();
    }
  });
}
test('workspace wait and clear arrive in order without delaying the next owner', { timeout: 2_000 }, async () => {
  const gate = new WorkspaceRunGate();
  let releaseWorkspace!: () => void;
  const busy = new Promise<void>(resolve => { releaseWorkspace = resolve; });
  let holdStatus!: () => void;
  const slowPost = new Promise<void>(resolve => { holdStatus = resolve; });
  let postedWait!: () => void;
  const waiting = new Promise<void>(resolve => { postedWait = resolve; });
  let postedClear!: () => void;
  const cleared = new Promise<void>(resolve => { postedClear = resolve; });
  const states: Array<string | null | undefined> = [];
  const first = gate.run('workspace', undefined, () => busy, { sessionId: 'first' });
  await new Promise<void>(resolve => setImmediate(resolve));
  const second = gate.run('workspace', undefined, async () => 'ran', {
    sessionId: 'second',
    onWaiting: async id => {
      states.push(id);
      if (id === null) postedClear();
      else {
        postedWait();
        await slowPost;
      }
    },
  });
  try {
    await waiting;
    releaseWorkspace();
    assert.equal(await second, 'ran');
    assert.deepEqual(states, ['first']);
    holdStatus();
    await cleared;
    assert.deepEqual(states, ['first', null]);
  } finally {
    releaseWorkspace();
    holdStatus();
    await first;
  }
});
