import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReportStoragePolicy } from '../src/report-storage.js';

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
test('storage protection latches until recovery and low-water marks', () => {
  const policy = new ReportStoragePolicy();
  assert.deepEqual(policy.update({ bytes: GiB * 0.79, limitBytes: GiB, freeBytes: GiB, online: true, persistenceFault: false }), { admit: true, stop: false });
  assert.deepEqual(policy.update({ bytes: GiB * 0.8, limitBytes: GiB, freeBytes: GiB, online: false, persistenceFault: false }), { admit: false, stop: false });
  assert.equal(policy.update({ bytes: GiB * 0.6, limitBytes: GiB, freeBytes: GiB, online: true, persistenceFault: false }).admit, false);
  assert.equal(policy.update({ bytes: GiB * 0.9, limitBytes: GiB, freeBytes: GiB, online: true, persistenceFault: false }).stop, true);
  assert.equal(policy.update({ bytes: GiB * 0.49, limitBytes: GiB, freeBytes: GiB, online: false, persistenceFault: false }).admit, false);
  assert.deepEqual(policy.update({ bytes: GiB * 0.49, limitBytes: GiB, freeBytes: GiB, online: true, persistenceFault: false }), { admit: true, stop: false });
});
test('physical free space and write failure independently activate protection', () => {
  const policy = new ReportStoragePolicy();
  const input = { bytes: 0, limitBytes: GiB, freeBytes: 250 * MiB, online: true, persistenceFault: false };
  assert.equal(policy.update(input).admit, false);
  assert.equal(policy.update({ ...input, freeBytes: 127 * MiB }).stop, true);
  assert.equal(policy.update({ ...input, freeBytes: 511 * MiB }).admit, false);
  assert.equal(policy.update({ ...input, freeBytes: GiB, persistenceFault: true }).stop, true);
});
