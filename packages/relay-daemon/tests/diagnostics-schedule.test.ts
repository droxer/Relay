import assert from 'node:assert/strict';
import test from 'node:test';
import { DiagnosticsSchedule } from '../src/diagnostics-schedule.js';

const healthy = { state: 'healthy', causes: [], recovered: false, pending: 0, runs: [], observedAt: 0 };

test('healthy diagnostics ignore volatile timestamps and refresh every thirty seconds', () => {
  const schedule = new DiagnosticsSchedule();
  assert.equal(schedule.due(healthy, 0), true);
  schedule.sent(healthy, 0);
  for (let now = 1000; now < 30_000; now += 1000) {
    assert.equal(schedule.due({ ...healthy, observedAt: now, accepted: now }, now), false);
  }
  assert.equal(schedule.due(healthy, 30_000), true);
});

test('healthy activity refreshes at thirty seconds while health transitions report immediately', () => {
  const schedule = new DiagnosticsSchedule();
  schedule.sent(healthy, 0);
  const busy = { ...healthy, pending: 1, runs: ['run'] };
  assert.equal(schedule.due(busy, 1000), false);
  assert.equal(schedule.due(busy, 5000), false);
  assert.equal(schedule.due(busy, 30_000), true);
  schedule.sent(busy, 30_000);
  const failed = { ...busy, state: 'retrying', causes: ['communication'], incident: 'incident' };
  assert.equal(schedule.due(failed, 30_001), true);
  schedule.sent(failed, 30_001);
  assert.equal(schedule.due(failed, 35_000), false);
  assert.equal(schedule.due(failed, 35_001), false);
  assert.equal(schedule.due(failed, 60_001), true);
  const recovering = { ...healthy, incident: 'incident' };
  assert.equal(schedule.due(recovering, 36_000), true);
  schedule.sent(recovering, 36_000);
  assert.equal(schedule.due(recovering, 41_000), true);
  const recovered = { ...recovering, recovered: true };
  assert.equal(schedule.due(recovered, 41_000), true);
  schedule.sent(recovered, 41_000);
  assert.equal(schedule.due(recovered, 46_000), false);
  assert.equal(schedule.due(recovered, 71_000), true);
});

test('failures back off independently of health changes and throttle warnings', () => {
  const schedule = new DiagnosticsSchedule();
  assert.equal(schedule.failed(0), true);
  assert.equal(schedule.due(healthy, 1000), false);
  assert.equal(schedule.due({ ...healthy, state: 'retrying' }, 4999), false);
  assert.equal(schedule.due(healthy, 5000), true);
  assert.equal(schedule.failed(5000, 60_000), false);
  assert.equal(schedule.due(healthy, 64_999), false);
  assert.equal(schedule.due(healthy, 65_000), true);
  assert.equal(schedule.failed(65_000), true);
  schedule.sent(healthy, 65_001);
  assert.equal(schedule.due(healthy, 95_001), true);
  assert.equal(schedule.failed(95_001), true);
});

test('the first quarantine reports immediately while subsequent counts are coalesced', () => {
  const schedule = new DiagnosticsSchedule();
  schedule.sent(healthy, 0);
  const quarantined = { ...healthy, quarantined: 1 };
  assert.equal(schedule.due(quarantined, 1), true);
  schedule.sent(quarantined, 1);
  assert.equal(schedule.due({ ...quarantined, quarantined: 2 }, 2), false);
  assert.equal(schedule.due({ ...quarantined, quarantined: 2 }, 30_001), true);
});
