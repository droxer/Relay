import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryAfterMs } from '../src/transport-retry.js';

test('Retry-After accepts seconds and HTTP dates without negative or nonfinite delays', () => {
  assert.equal(retryAfterMs('3', 0), 3000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 1000), 4000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:00 GMT', 1000), 0);
  for (const value of [null, '', 'no', '-1', 'Infinity']) assert.equal(retryAfterMs(value, 0), 0);
});
