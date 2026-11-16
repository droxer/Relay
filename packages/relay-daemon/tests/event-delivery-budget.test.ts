import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { postJsonWithRetry } from '../src/backend-transport.js';
import { TerminalOutbox } from '../src/terminal-outbox.js';

for (const batching of [false, true]) {
  test(`replay does not spend a day's budget during a brief outage (batching=${batching})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'relay-replay-pacing-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const outbox = new TerminalOutbox(root);
    outbox.negotiate(batching, batching);
    outbox.retain({ type: 'run.completed', commandId: 'brief-outage' });
    let requests = 0;
    const unavailable: typeof fetch = async () => {
      requests++;
      return new Response('unavailable', { status: 503 });
    };
    for (let tick = 0; tick < 20; tick++) {
      await outbox.replay(unavailable, 'http://backend/events', 'token');
      now += 50;
    }
    assert.equal(requests, 1, 'a one-second outage must leave retry budget for recovery');
    outbox.negotiate(false, false);
    await outbox.replay(async () => { requests++; return Response.json({}); }, 'http://backend/events', 'token');
    assert.equal(requests, 2);
    assert.equal(outbox.status().pending, 0);
  });

  test(`network failures share live and replay backoff (batching=${batching})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'relay-shared-backoff-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const outbox = new TerminalOutbox(root);
    outbox.negotiate(batching, batching);
    const event = { type: 'run.completed', commandId: 'network-outage' };
    const request = { method: 'POST', body: JSON.stringify(event) };
    let requests = 0;
    const unavailable: typeof fetch = async () => { requests++; throw new Error('reset'); };
    await assert.rejects(outbox.wrapFetch(unavailable)('http://backend/events', request), /reset/);
    for (let tick = 0; tick < 20; tick++) {
      await outbox.replay(unavailable, 'http://backend/events', 'token');
      assert.equal((await outbox.wrapFetch(unavailable)('http://backend/events', request)).status, 429);
      now += 50;
    }
    assert.equal(requests, 1);
    await outbox.replay(unavailable, 'http://backend/events', 'token');
    assert.equal(requests, 2);
    now += 1000;
    await outbox.replay(unavailable, 'http://backend/events', 'token');
    assert.equal(requests, 2, 'the second failure doubles the shared backoff');
    now += 1000;
    await outbox.replay(unavailable, 'http://backend/events', 'token');
    assert.equal(requests, 3);
  });

  test(`shared backoff preserves backend Retry-After (batching=${batching})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'relay-shared-retry-after-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let now = Date.now();
    t.mock.method(Date, 'now', () => now);
    const outbox = new TerminalOutbox(root);
    outbox.negotiate(batching, batching);
    const event = { type: 'run.completed', commandId: 'busy' };
    const request = { method: 'POST', body: JSON.stringify(event) };
    outbox.retain(event);
    let requests = 0;
    const busy: typeof fetch = async () => {
      requests++;
      return new Response('busy', { status: 503, headers: { 'Retry-After': '5' } });
    };
    await outbox.replay(busy, 'http://backend/events', 'token');
    now += 4999;
    await outbox.replay(busy, 'http://backend/events', 'token');
    assert.equal((await outbox.wrapFetch(busy)('http://backend/events', request)).status, 429);
    assert.equal(requests, 1);
    now++;
    await outbox.replay(busy, 'http://backend/events', 'token');
    assert.equal(requests, 2);
  });
}

test('a ten-second completion response is accepted on its first attempt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'relay-slow-event-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outbox = new TerminalOutbox(root);
  let requests = 0;
  let retries = 0;
  const send = outbox.wrapFetch(async (_url, init) => {
    requests++;
    await sleep(10_000, undefined, { signal: init?.signal ?? undefined });
    return Response.json({});
  });
  await postJsonWithRetry(send, 'http://backend/events', { type: 'run.completed', commandId: 'slow', generatedFiles: [] }, 'token', AbortSignal.timeout(15_000), () => retries++);
  assert.equal(requests, 1);
  assert.equal(retries, 0);
  assert.equal(outbox.status().pending, 0);
});

for (const batching of [false, true]) {
  test(`compaction and batch fallback cannot bypass the wire budget (batching=${batching})`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'relay-fallback-budget-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let calls = 0;
    const event = { type: 'run.completed', commandId: 'large', agentLog: 'result', generatedFiles: [] };
    for (let attempt = 0; attempt < 12; attempt++) {
      const outbox = new TerminalOutbox(root);
      outbox.negotiate(batching, batching);
      outbox.retain(event);
      await outbox.replay(async () => { calls++; return new Response('too large', { status: 413 }); }, 'http://backend/events', 'token');
    }
    assert.equal(calls, 10);
    assert.equal(new TerminalOutbox(root).status().pending, 1);
    assert.equal(new TerminalOutbox(root).status().quarantined, 0);
  });
}
