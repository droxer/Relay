/** Local synthetic characterization; run after compiling packages/tsconfig.json.
 * Uses disposable private storage and no backend or agent credentials.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, platform, arch } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { RunSupervisor } from '../../dist/packages/relay-daemon/src/run-supervisor.js';
import { AdmissionLedger } from '../../dist/packages/relay-daemon/src/admission-ledger.js';
import { ExecutionJournal } from '../../dist/packages/relay-daemon/src/execution-journal.js';
import { ExecutionWatchdog } from '../../dist/packages/relay-daemon/src/execution-watchdog.js';
import { WorkspaceRunGate } from '../../dist/packages/relay-daemon/src/workspace-run-gate.js';
import { TerminalOutbox } from '../../dist/packages/relay-daemon/src/terminal-outbox.js';

const root = mkdtempSync(join(tmpdir(), 'relay-runtime-benchmark-'));
const tick = () => new Promise(resolve => setTimeout(resolve, 25));
const results = { node: process.version, platform: platform(), arch: arch(), runs: [], history: [] };
try {
  for (const capacity of [1, 5, 20]) {
    const directory = join(root, `capacity-${capacity}`);
    const journal = new ExecutionJournal(join(directory, 'executions'));
    const ledger = new AdmissionLedger(join(directory, 'admissions'));
    const outbox = new TerminalOutbox(join(directory, 'reports'), id => {
      journal.confirmExit(id);
      supervisor.terminalStored(id);
    });
    let completed = 0;
    const supervisor = new RunSupervisor({
      journal, ledger, watchdog: new ExecutionWatchdog(), workspaceGate: new WorkspaceRunGate(directory),
      maxConcurrentRuns: capacity, runtimeLimits: {}, leaseDurationMs: 60_000,
      sandboxId: 'benchmark', logger: { info() {}, warn() {}, error() {}, output() {} },
      report: async event => { await outbox.retain(event).durable; completed++; },
      exitUnconfirmed: async () => assert.fail('synthetic run has no child process'), onIdle() {},
    });
    const lag = monitorEventLoopDelay({ resolution: 10 });
    lag.enable(); await tick();
    const started = performance.now();
    for (let offset = 0; offset < 100; offset += capacity) {
      for (let slot = offset; slot < Math.min(offset + capacity, 100); slot++) {
        const id = `run-${slot}`;
        const command = { type: 'run.start', id, sessionId: id, runId: id, agent: 'codex' };
        assert.equal(supervisor.accept(command, undefined, async () => ({
          type: 'run.completed', commandId: id, sessionId: id, runId: id, agent: 'codex',
        })), 'accepted');
      }
      await supervisor.settle();
      await new Promise(resolve => setImmediate(resolve));
    }
    const durationMs = performance.now() - started;
    await tick(); lag.disable();
    assert.equal(completed, 100);
    assert.equal(journal.pending().length, 0);
    assert.equal(outbox.status().pending, 100);
    results.runs.push({ capacity, completed, durationMs, eventLoopP99Ms: lag.percentile(99) / 1e6,
      retainedBytes: outbox.status().bytes, rssBytes: process.memoryUsage().rss });
  }
  for (const count of [10_000, 100_000, 1_000_000]) {
    const directory = join(root, `history-${count}`);
    mkdirSync(directory);
    const buckets = new Map();
    // Setup models historical fences; fixture creation is outside measured work.
    for (let i = 0; i < count; i++) {
      const hash = createHash('sha256').update(`history-${i}`).digest();
      const bucket = hash.toString('hex').slice(0, 3);
      const entries = buckets.get(bucket) ?? [];
      entries.push(hash); buckets.set(bucket, entries);
    }
    for (const [bucket, entries] of buckets) writeFileSync(join(directory, `${bucket}.fences`), Buffer.concat(entries));
    buckets.clear();
    const ledger = new AdmissionLedger(directory);
    const latencies = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      assert.equal(ledger.has(`history-${Math.floor(i * count / 100)}`), true);
      assert.equal(ledger.has(`absent-${i}`), false);
      latencies.push(performance.now() - started);
    }
    latencies.sort((a, b) => a - b);
    results.history.push({ commands: count, coldLookupPairP99Ms: latencies[98] });
  }
  console.log(JSON.stringify(results, null, 2));
} finally { rmSync(root, { recursive: true, force: true }); }
