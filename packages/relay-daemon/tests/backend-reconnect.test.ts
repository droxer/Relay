import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DaemonHttpError,
  DaemonStoppedError,
  Wakeup,
  backendReconnectDelayMs,
  withBackendReconnect,
} from '../src/backend-transport.js';
import { watchForWake } from '../src/wake-detector.js';

const context = { sandboxId: 'sbx_test', what: 'command poll' };

function recordingLogger() {
  const warnings: Array<Record<string, unknown>> = [];
  const infos: Array<{ message: string; fields: Record<string, unknown> }> = [];
  return {
    warnings, infos,
    warn: (_message: string, fields: Record<string, unknown> = {}) => { warnings.push(fields); },
    info: (message: string, fields: Record<string, unknown> = {}) => { infos.push({ message, fields }); },
  };
}

test('reconnect backoff stays quick through a restart and widens for a sustained outage', () => {
  assert.equal(backendReconnectDelayMs(20, () => 1), 1500);
  assert.equal(backendReconnectDelayMs(21, () => 1), 3000);
  assert.equal(backendReconnectDelayMs(22, () => 1), 6000);
  assert.equal(backendReconnectDelayMs(24, () => 1), 15000);
  assert.equal(backendReconnectDelayMs(500, () => 1), 15000);
  assert.equal(backendReconnectDelayMs(500, () => 0), 7500);
});

test('a lone 401 is confirmed before it counts as a rejected credential', async () => {
  let calls = 0;
  let rejected = 0;
  const result = await withBackendReconnect(async () => {
    calls += 1;
    if (calls === 1) throw new DaemonHttpError('unauthorized', 401);
    return 'ok';
  }, recordingLogger(), context, { confirmUnauthorized: true, onCredentialRejected: () => { rejected += 1; } });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(rejected, 0);
});

test('a request made for one run fails on its first 401', async () => {
  let calls = 0;
  await assert.rejects(withBackendReconnect(async () => {
    calls += 1;
    throw new DaemonHttpError('unauthorized', 401);
  }, recordingLogger(), context));
  assert.equal(calls, 1);
});

test('a repeated 401 stops with the credential rejected', async () => {
  let calls = 0;
  let rejected = 0;
  await assert.rejects(withBackendReconnect(async () => {
    calls += 1;
    throw new DaemonHttpError('unauthorized', 401);
  }, recordingLogger(), context, { confirmUnauthorized: true, onCredentialRejected: () => { rejected += 1; } }),
  (error: unknown) => error instanceof DaemonHttpError && error.status === 401);
  assert.equal(calls, 2);
  assert.equal(rejected, 1);
});

test('a 401 separated from the next by an outage is confirmed again', async () => {
  const statuses = [401, 503, 401, 200];
  let calls = 0;
  await withBackendReconnect(async () => {
    const status = statuses[calls++]!;
    if (status !== 200) throw new DaemonHttpError('failed', status);
  }, recordingLogger(), context, { confirmUnauthorized: true });
  assert.equal(calls, 4);
});

test('gone stops at once, without a confirming request', async () => {
  let calls = 0;
  let rejected = 0;
  await assert.rejects(withBackendReconnect(async () => {
    calls += 1;
    throw new DaemonHttpError('deleted', 410);
  }, recordingLogger(), context, { confirmUnauthorized: true, rejectionGraceMs: 60_000, onCredentialRejected: () => { rejected += 1; } }));
  assert.equal(calls, 1);
  assert.equal(rejected, 1);
});

test('an unrelated refusal is fatal before the daemon serves and rides out a grace once it does', async () => {
  await assert.rejects(withBackendReconnect(async () => {
    throw new DaemonHttpError('not found', 404);
  }, recordingLogger(), context));

  let calls = 0;
  let outages = 0;
  await withBackendReconnect(async () => {
    calls += 1;
    if (calls < 3) throw new DaemonHttpError('proxy says no', calls === 1 ? 404 : 403);
  }, recordingLogger(), context, { rejectionGraceMs: 60_000, onTransientFailure: () => { outages += 1; } });
  assert.equal(calls, 3);
  // A proxy's refusal says nothing about reachability, so it starts no outage grace.
  assert.equal(outages, 0);
});

test('a refusal that outlasts its grace is fatal', async () => {
  let calls = 0;
  await assert.rejects(withBackendReconnect(async () => {
    calls += 1;
    throw new DaemonHttpError('forbidden', 403);
  }, recordingLogger(), context, { rejectionGraceMs: 150 }),
  (error: unknown) => error instanceof DaemonHttpError && error.status === 403);
  assert.ok(calls >= 2);
});

test('a wake ends the backoff wait and recovery is logged once', async () => {
  const wake = new Wakeup();
  const logger = recordingLogger();
  let calls = 0;
  const startedAt = performance.now();
  const pending = withBackendReconnect(async () => {
    calls += 1;
    // Far past the quick attempts the delay would be seconds; Retry-After forces it here.
    if (calls === 1) throw new DaemonHttpError('unavailable', 503, 60_000);
    return 'ok';
  }, logger, context, { wake });
  setTimeout(() => wake.notify(), 20);
  assert.equal(await pending, 'ok');
  assert.ok(performance.now() - startedAt < 5_000);
  assert.equal(logger.warnings.length, 1);
  assert.deepEqual(logger.infos.map(entry => entry.message), ['command poll recovered']);
  assert.equal(logger.infos[0]!.fields.attempts, 1);
});

test('a retry that keeps failing warns once per interval, not once per attempt', async () => {
  const logger = recordingLogger();
  let calls = 0;
  await withBackendReconnect(async () => {
    calls += 1;
    if (calls <= 4) throw new Error('fetch failed');
  }, logger, context);
  assert.equal(calls, 5);
  assert.equal(logger.warnings.length, 1);
  assert.equal(logger.warnings[0]!.attempt, 1);
});

test('stopping during a woken wait ends the retry', async () => {
  const stop = new AbortController();
  const wake = new Wakeup();
  const pending = withBackendReconnect(async () => {
    throw new DaemonHttpError('unavailable', 503, 60_000);
  }, recordingLogger(), context, { wake, signal: stop.signal });
  setTimeout(() => stop.abort(), 20);
  await assert.rejects(pending, DaemonStoppedError);
});

test('a wait with no notify still ends on its own', async () => {
  const wake = new Wakeup();
  await wake.wait(5);
  wake.notify();
});

test('a tick that arrives long after it was due reports the pause', async () => {
  let clock = 0;
  const pauses: number[] = [];
  const stop = watchForWake(pausedMs => pauses.push(pausedMs), { intervalMs: 5, thresholdMs: 1_000, now: () => clock });
  try {
    clock = 5;
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.deepEqual(pauses, []);
    clock += 60_005;
    await new Promise(resolve => setTimeout(resolve, 12));
    assert.equal(pauses[0], 60_000);
  } finally {
    stop();
  }
});
