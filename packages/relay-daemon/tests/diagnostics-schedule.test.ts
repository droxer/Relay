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

test('activity is coalesced while health transitions report immediately', () => {
  const schedule = new DiagnosticsSchedule();
  schedule.sent(healthy, 0);
  const busy = { ...healthy, pending: 1, runs: ['run'] };
  assert.equal(schedule.due(busy, 1000), false);
  assert.equal(schedule.due(busy, 5000), true);
  schedule.sent(busy, 5000);
  const failed = { ...busy, state: 'retrying', causes: ['communication'], incident: 'incident' };
  assert.equal(schedule.due(failed, 5001), true);
  schedule.sent(failed, 5001);
  assert.equal(schedule.due(failed, 10000), false);
  assert.equal(schedule.due(failed, 10001), true);
  // A failed POST must not advance the schedule; the next sample retries.
  assert.equal(schedule.due(failed, 11000), true);
  const recovering = { ...healthy, incident: 'incident' };
  assert.equal(schedule.due(recovering, 11000), true);
  schedule.sent(recovering, 11000);
  assert.equal(schedule.due(recovering, 16000), true);
  const recovered = { ...recovering, recovered: true };
  assert.equal(schedule.due(recovered, 16000), true);
  schedule.sent(recovered, 16000);
  assert.equal(schedule.due(recovered, 21000), false);
  assert.equal(schedule.due(recovered, 46000), true);
});
