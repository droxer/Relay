import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import { postJsonWithRetry } from '../src/backend-transport.js';
import { TerminalOutbox } from '../src/terminal-outbox.js';

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
