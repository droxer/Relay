import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { TerminalOutbox } from '../src/terminal-outbox.js';

const output = (sequence = 0, commandId = 'cmd') => ({ type: 'run.output', commandId, leaseId: 'lease', sequence, text: 'chunk' });
function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'relay-reliable-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('output is durable before the first network attempt', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  await outbox.wrapFetch(async () => {
    const files = readdirSync(root).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1);
    assert.equal(JSON.parse(readFileSync(join(root, files[0]!), 'utf8')).text, 'chunk');
    return new Response('{}');
  })('http://backend/events', { method: 'POST', body: JSON.stringify(output()) });
});

test('shutdown pressure preserves the crossing chunk and reserves terminal space', async t => {
  const root = fixture(t);
  let protections = 0;
  const outbox = new TerminalOutbox(root, undefined, 10_000);
  outbox.setPressureHandler(() => protections++);
  await outbox.retain({ ...output(), text: 'x'.repeat(9_000) }).durable;
  assert.equal(protections, 1);
  assert.equal(outbox.status().quotaExceeded, true);
  assert.equal(outbox.pending().length, 1);
  outbox.retain({ type: 'run.cancelled', commandId: 'cmd', reason: 'Storage protection' });
  assert.equal(outbox.pending().length, 2);
  assert.throws(() => outbox.retain({ ...output(1), text: 'x'.repeat(1_000) }), /storage limit/);
  assert.equal(outbox.status().persistenceFault, true);
});

test('permanently rejected output survives restart and is not automatically retried', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  await outbox.wrapFetch(async () => new Response('conflict', { status: 409 }))('http://backend/events', {
    method: 'POST', body: JSON.stringify(output()),
  });
  await outbox.flush();
  const restarted = new TerminalOutbox(root);
  assert.equal(restarted.pending().length, 1);
  let attempts = 0;
  await restarted.replay(async () => { attempts++; return new Response('{}'); }, 'http://backend/events', 'token');
  assert.equal(attempts, 0);
  assert.equal(restarted.pending().length, 1);
});

test('a killed daemon leaves durably captured output available for replay', async t => {
  const root = fixture(t);
  const moduleUrl = new URL('../src/terminal-outbox.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
    const { TerminalOutbox } = await import(${JSON.stringify(moduleUrl)});
    const outbox = new TerminalOutbox(${JSON.stringify(root)});
    await outbox.retain(${JSON.stringify(output())}).durable;
    process.kill(process.pid, 'SIGKILL');
  `]);
  assert.equal(child.signal, 'SIGKILL');
  const recovered = new TerminalOutbox(root);
  assert.equal(recovered.pending()[0]?.event.text, 'chunk');
  await recovered.replay(async () => new Response('{}'), 'http://backend/events', 'token');
  assert.equal(recovered.pending().length, 0);
});

test('quarantined output blocks its successors but not terminal or unrelated reports', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  await outbox.wrapFetch(async () => new Response('conflict', { status: 409 }))('http://backend/events', {
    method: 'POST', body: JSON.stringify(output()),
  });
  outbox.retain(output(1));
  outbox.retain(output(0, 'other'));
  outbox.retain({ type: 'run.completed', commandId: 'cmd', leaseId: 'lease', exitCode: 0 });
  const sent: string[] = [];
  await outbox.replay(async (_url, init) => { sent.push(JSON.parse(String(init?.body)).commandId); return new Response('{}'); }, 'http://backend/events', 'token');
  assert.deepEqual(sent, ['cmd', 'other']);
  assert.equal(outbox.pending().length, 2);
});

test('corrupt reports do not hide readable exit evidence on restart', t => {
  const root = fixture(t);
  new TerminalOutbox(root).retain({ type: 'run.completed', commandId: 'cmd', exitCode: 0 });
  writeFileSync(join(root, 'corrupt.json'), '{');
  const errors: Error[] = [];
  const restarted = new TerminalOutbox(root, undefined, undefined, error => errors.push(error));
  assert.equal(restarted.pending().length, 1);
  assert.equal(errors.length, 1);
  assert.equal(readFileSync(join(root, 'corrupt.json'), 'utf8'), '{');
});

test('terminal replay takes priority over a large output backlog', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  for (let sequence = 0; sequence < 60; sequence++) outbox.retain(output(sequence));
  outbox.retain({ type: 'run.completed', commandId: 'cmd', leaseId: 'lease', exitCode: 0 });
  const sent: string[] = [];
  await outbox.replay(async (_url, init) => { sent.push(JSON.parse(String(init?.body)).type); return new Response('{}'); }, 'http://backend/events', 'token');
  assert.equal(sent[0], 'run.completed');
});

for (const batching of [false, true]) {
  test(`replay fairly interleaves streams with different sequence positions (batching=${batching})`, async t => {
    const outbox = new TerminalOutbox(fixture(t));
    outbox.negotiate(true, batching);
    for (let seq = 0; seq < 60; seq++) await outbox.retain(output(seq, 'bulk')).durable;
    await outbox.retain(output(10000, 'interactive')).durable;
    const sent: string[] = [];
    await outbox.replay(async (_url, init) => {
      const payload = JSON.parse(String(init?.body));
      if (payload.reports) {
        sent.push(...payload.reports.map((report: { body: string }) => JSON.parse(report.body).commandId));
        return Response.json({ receipts: payload.reports.map((r: { id: string; digest: string }) => ({ ...r, status: 200 })) });
      }
      sent.push(payload.commandId);
      const headers = new Headers(init?.headers);
      return new Response('{}', { headers });
    }, 'http://backend/events', 'token');
    assert.ok(sent.indexOf('interactive') >= 0 && sent.indexOf('interactive') < 3, sent.join(','));
  });
}

test('quarantined backlog does not repeatedly enumerate the index per successor', async t => {
  const outbox = new TerminalOutbox(fixture(t));
  for (let seq = 0; seq < 256; seq++) await outbox.retain(output(seq)).durable;
  await outbox.wrapFetch(async () => new Response('conflict', { status: 409 }))('http://backend/events', {
    method: 'POST', body: JSON.stringify(output()),
  });
  // Count metadata visits rather than asserting machine-dependent timings.
  const index = (outbox as unknown as { index: Map<string, unknown> }).index;
  const iterate = index[Symbol.iterator].bind(index);
  let visits = 0;
  index[Symbol.iterator] = function* () { for (const item of iterate()) { visits++; yield item; } return undefined; };
  outbox.negotiate(true, true);
  await outbox.replay(async () => { throw new Error('blocked output must not be sent'); }, 'http://backend/events', 'token');
  assert.ok(visits < 2000, `replay visited ${visits} metadata entries`);
});

test('strict peers retain reports until identity and payload acceptance are proven', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  outbox.negotiate(true);
  const event = output();
  let calls = 0;
  const send = outbox.wrapFetch(async (_url, init) => {
    calls++;
    const headers = new Headers(init?.headers);
    return calls === 1 ? new Response('{}') : new Response('{}', { headers: {
      'X-Relay-Report-Id': headers.get('X-Relay-Report-Id')!,
      'X-Relay-Report-Digest': headers.get('X-Relay-Report-Digest')!,
    } });
  });
  assert.equal((await send('http://backend/events', { method: 'POST', body: JSON.stringify(event) })).status, 503);
  assert.equal(outbox.pending().length, 1);
  assert.equal((await send('http://backend/events', { method: 'POST', body: JSON.stringify(event) })).status, 200);
  assert.equal(outbox.pending().length, 0);
});

test('negotiated replay bundles ordered reports without losing per-report proof', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  outbox.negotiate(true, true);
  for (let seq = 0; seq < 5; seq++) outbox.retain(output(seq));
  let requests = 0;
  await outbox.replay(async (url, init) => {
    requests++;
    assert.ok(String(url).endsWith('/reports'));
    const reports = JSON.parse(String(init?.body)).reports as Array<{ id: string; digest: string; body: string }>;
    assert.deepEqual(reports.map(report => JSON.parse(report.body).sequence), [0, 1, 2, 3, 4]);
    return Response.json({ receipts: reports.map(report => ({ id: report.id, digest: report.digest, status: 200 })) });
  }, 'http://backend/events', 'token');
  assert.equal(requests, 1);
  assert.equal(outbox.pending().length, 0);
});

test('quarantine interventions are explicit, audited, and never count discard as delivery', async t => {
  const root = fixture(t);
  const outbox = new TerminalOutbox(root);
  const send = outbox.wrapFetch(async () => new Response('conflict', { status: 409 }));
  await send('http://backend/events', { method: 'POST', body: JSON.stringify(output()) });
  const key = outbox.pending()[0]!.key;
  assert.throws(() => outbox.discardQuarantined(key, 'operator', false), /acknowledge/);
  outbox.retryQuarantined(key, 'operator');
  assert.equal(outbox.status().quarantined, 0);
  await send('http://backend/events', { method: 'POST', body: JSON.stringify(output()) });
  outbox.discardQuarantined(key, 'operator', true);
  assert.equal(outbox.status().pending, 0);
  assert.equal(outbox.status().accepted, 0);
  assert.equal(readdirSync(root).filter(name => name.endsWith('.audit')).length, 2);
});

test('failed streams cannot monopolize the next bounded replay window', async t => {
  const outbox = new TerminalOutbox(fixture(t));
  outbox.negotiate(true, true);
  for (let i = 0; i < 100; i++) await outbox.retain(output(0, `owner-${i}`)).durable;
  const owners = new Set<string>();
  const unavailable: typeof fetch = async (_url, init) => {
    const { reports } = JSON.parse(String(init?.body));
    for (const report of reports) owners.add(JSON.parse(report.body).commandId);
    return new Response('temporarily unavailable', { status: 503 });
  };
  await outbox.replay(unavailable, 'http://backend/events', 'token');
  await outbox.replay(unavailable, 'http://backend/events', 'token');
  assert.equal(owners.size, 100, 'each owner needs a chance before failed heads repeat');
});
