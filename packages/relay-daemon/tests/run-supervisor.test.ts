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

function fixture(t: test.TestContext, capacity = 2) {
  const root = mkdtempSync(join(tmpdir(), 'relay-supervision-'));
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

test('a partial admission write stays fenced and never executes on retry', async t => {
  const { supervisor, journal, ledger } = fixture(t);
  const original = ledger.add.bind(ledger);
  ledger.add = () => { throw Error('disk full'); };
  let started = false;
  const execute = async () => { started = true; return done('a'); };
  assert.throws(() => supervisor.accept(command('a'), 'a', execute), /disk full/);
  assert.equal(journal.has('a'), true);
  ledger.add = original;
  assert.equal(supervisor.accept(command('a'), 'a', execute), 'recovery-required');
  await tick();
  assert.equal(started, false);
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
