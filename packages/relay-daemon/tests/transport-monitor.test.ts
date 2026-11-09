import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TransportMonitor } from '../src/transport-monitor.js';

test('outage escalation persists its identity and recovery requires all failed channels', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-incident-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 0;
  const monitor = new TransportMonitor(root, () => now);
  monitor.failure('poll');
  now = 59_999;
  assert.equal(monitor.snapshot().incident, undefined);
  now = 60_000;
  const episode = monitor.snapshot().incident;
  assert.ok(episode);
  monitor.failure('output');
  monitor.success('poll');
  now += 11_000;
  assert.ok(monitor.snapshot().causes.includes('communication'));
  monitor.success('output');
  now += 10_000;
  assert.deepEqual(monitor.snapshot().causes, []);
  assert.equal(monitor.snapshot().incident, episode);
  assert.equal(monitor.snapshot().recovered, true);
  assert.equal(new TransportMonitor(root, () => now).snapshot().incident, episode);
});

test('storage and rejection causes survive communication recovery', t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-incident-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = 100;
  const monitor = new TransportMonitor(root, () => now);
  monitor.cause('storage', true);
  const incident = monitor.snapshot().incident;
  assert.ok(incident);
  monitor.failure('poll');
  monitor.success('poll');
  now += 11_000;
  assert.deepEqual(monitor.snapshot().causes, ['storage']);
  assert.equal(monitor.snapshot().incident, incident);
});
