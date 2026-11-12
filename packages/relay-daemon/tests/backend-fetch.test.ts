import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createSecureServer, constants, type ServerHttp2Session } from 'node:http2';
import { resolve } from 'node:path';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { test } from 'node:test';

// Public, test-only localhost certificate. The child trusts it without disabling
// TLS verification, and exercises the same fetch used by the installed daemon.
test('backend tries fresh H2 pools before falling back, preserving TLS, proxy and cancellation behavior', async () => {
  const fixtures = resolve('packages/relay-daemon/tests/fixtures/tls');
  const sessions = new Set<ServerHttp2Session>();
  let h2Requests = 0;
  let h2Sessions = 0;
  const requests: string[] = [];
  const sockets = new Set<Duplex>();
  const server = createSecureServer({
    key: readFileSync(`${fixtures}/key.pem`), cert: readFileSync(`${fixtures}/cert.pem`), allowHTTP1: true,
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  server.on('session', session => {
    h2Sessions++;
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.on('stream', (stream, headers) => {
    h2Requests++;
    stream.on('error', () => {});
    if (headers[':path'] === '/healthy' || headers[':path'] === '/status500') {
      stream.respond({ ':status': headers[':path'] === '/status500' ? 500 : 200 });
      stream.end('{"ok":true}');
    } else stream.close(constants.NGHTTP2_INTERNAL_ERROR);
  });
  server.on('request', (request, response) => {
    if (request.httpVersionMajor !== 1) return;
    requests.push(`${request.method} ${request.url}`);
    request.resume();
    if (request.url === '/stalled') {
      response.writeHead(200);
      response.write(' ');
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    response.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, 'localhost', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try {
    const moduleUrl = new URL('../src/backend-fetch.js', import.meta.url).href;
    const url = `https://localhost:${address.port}`;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createBackendFetch } from ${JSON.stringify(moduleUrl)};
      const recoveries = [];
      const backendFetch = createBackendFetch(event => recoveries.push(event), { http2: true });
      import { Agent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
      // Model an H2-enabled host even on Node versions whose default is H1.
      const hostDispatcher = new Agent({ allowH2: true });
      setGlobalDispatcher(hostDispatcher);
      // Keep successful H2, including HTTP error responses. Healthy heartbeats
      // between recurring stream resets must not prevent eventual fallback.
      for (const path of ['/healthy', '/status500']) await (await backendFetch(${JSON.stringify(url)} + path)).text();
      await assert.rejects(backendFetch(${JSON.stringify(url)} + '/first-reset'));
      await (await backendFetch(${JSON.stringify(url)} + '/healthy')).text();
      for (let attempt = 0; attempt < 2; attempt++) {
        await assert.rejects(backendFetch(${JSON.stringify(url)} + '/reset', {method: 'POST', body: '{}'}));
      }
      assert.deepEqual(recoveries.map(event => event.protocol), ['http/2', 'http/2', 'http/1.1']);
      assert.deepEqual(recoveries.map(event => event.http2Failures), [1, 2, 3]);
      assert.match(recoveries.at(-1).error, /http2Reset=NGHTTP2_INTERNAL_ERROR/);
      await Promise.all([['commands', 'GET'], ['heartbeat', 'POST'], ['transport', 'POST']].map(async ([path, method]) => {
        const response = await backendFetch(${JSON.stringify(url)} + '/' + path, {
          method, signal: AbortSignal.timeout(4000),
          ...(method === 'POST' ? { body: '{}' } : {}),
        });
        assert.deepEqual(await response.json(), {ok: true});
      }));
      const controller = new AbortController();
      const stalled = await backendFetch(${JSON.stringify(url)} + '/stalled', { signal: controller.signal });
      controller.abort();
      await assert.rejects(stalled.text(), {name: 'AbortError'});
      assert.equal((await backendFetch(${JSON.stringify(url)} + '/after-abort')).status, 200);
      assert.equal(getGlobalDispatcher(), hostDispatcher);
      await hostDispatcher.close();
    `], {
      timeout: 15000,
      env: { ...process.env, NODE_EXTRA_CA_CERTS: `${fixtures}/cert.pem`,
        HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*' },
    });
    assert.equal(h2Requests, 6);
    assert.equal(h2Sessions, 3);
    assert.deepEqual(requests.sort(), ['GET /after-abort', 'GET /commands', 'GET /stalled', 'POST /heartbeat', 'POST /transport']);
    // Environment proxies must keep working with the dedicated dispatcher.
    const proxy = createServer();
    let tunnels = 0;
    proxy.on('connect', (request, socket, head) => {
      assert.equal(request.url, `localhost:${address.port}`);
      tunnels++;
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      const upstream = connect(address.port, 'localhost', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      });
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
    });
    await new Promise<void>(resolve => proxy.listen(0, 'localhost', resolve));
    const proxyAddress = proxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== 'string');
    try {
      await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        import { createBackendFetch } from ${JSON.stringify(moduleUrl)};
        const backendFetch = createBackendFetch(undefined, { http2: true });
        const response = await backendFetch(${JSON.stringify(url)} + '/healthy');
        assert.deepEqual(await response.json(), {ok: true});
      `], { timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: `${fixtures}/cert.pem`,
        HTTP_PROXY: '', http_proxy: '', HTTPS_PROXY: `http://localhost:${proxyAddress.port}`,
        https_proxy: `http://localhost:${proxyAddress.port}`, NO_PROXY: '', no_proxy: '' } });
      assert.equal(tunnels, 1);
      assert.equal(h2Requests + requests.filter(request => request === 'GET /healthy').length, 7);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => proxy.close(() => resolve()));
    }
    // Without the opt-in the daemon speaks HTTP/1.1, even on a host whose fetch defaults to HTTP/2.
    const h2Before = h2Requests;
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createBackendFetch } from ${JSON.stringify(moduleUrl)};
      import { Agent, setGlobalDispatcher } from 'undici';
      const hostDispatcher = new Agent({ allowH2: true });
      setGlobalDispatcher(hostDispatcher);
      const response = await createBackendFetch()(${JSON.stringify(url)} + '/default');
      assert.deepEqual(await response.json(), {ok: true});
      await hostDispatcher.close();
    `], { timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: `${fixtures}/cert.pem`, RELAY_DAEMON_HTTP_PROTOCOL: '',
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    assert.equal(h2Requests, h2Before);
    assert.ok(requests.includes('GET /default'));
    // Selecting HTTP/1.1 must not bypass certificate validation.
    await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createBackendFetch } from ${JSON.stringify(moduleUrl)};
      const backendFetch = createBackendFetch();
      await assert.rejects(backendFetch(${JSON.stringify(url)}), error =>
        error.cause?.code === 'DEPTH_ZERO_SELF_SIGNED_CERT');
    `], { timeout: 10000, env: { ...process.env, NODE_EXTRA_CA_CERTS: '', NODE_TLS_REJECT_UNAUTHORIZED: '1',
      HTTP_PROXY: '', HTTPS_PROXY: '', http_proxy: '', https_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
  } finally {
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

function streamFailure(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('Stream closed with error code NGHTTP2_INTERNAL_ERROR'), {
    code: 'ERR_HTTP2_STREAM_ERROR',
  }) });
}

test('fallback is isolated by origin and does not replay failed requests', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const recoveries: Array<{ origin: string; http2Failures: number; protocol: string }> = [];
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw streamFailure(); });
  const send = createBackendFetch(event => recoveries.push(event), { http2: true });
  for (let i = 0; i < 4; i++) await assert.rejects(send('https://one.test/reports', { method: 'POST', body: '{}' }));
  await assert.rejects(send('https://two.test/commands'));
  assert.equal(calls, 5);
  assert.deepEqual(recoveries.map(({ origin, http2Failures, protocol }) => [origin, http2Failures, protocol]), [
    ['https://one.test', 1, 'http/2'], ['https://one.test', 2, 'http/2'],
    ['https://one.test', 3, 'http/1.1'], ['https://two.test', 1, 'http/2'],
  ]);
});

test('late failures and successes from retired pools do not change the recovery budget', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const pending: Array<{ resolve: (response: Response) => void; reject: (error: Error) => void }> = [];
  const failures: number[] = [];
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>((resolve, reject) => pending.push({ resolve, reject })));
  const send = createBackendFetch(event => failures.push(event.http2Failures), { http2: true });
  const first = assert.rejects(send('https://one.test/commands'));
  const lateFailure = assert.rejects(send('https://one.test/heartbeat'));
  const lateSuccess = send('https://one.test/transport');
  pending[0].reject(streamFailure()); await first;
  pending[1].reject(streamFailure()); await lateFailure;
  const second = assert.rejects(send('https://one.test/commands'));
  pending[3].reject(streamFailure()); await second;
  pending[2].resolve(new Response('{}')); await lateSuccess;
  const third = assert.rejects(send('https://one.test/commands'));
  pending[4].reject(streamFailure()); await third;
  assert.deepEqual(failures, [1, 2, 3]);
});

test('caller cancellation and ordinary network errors do not trigger protocol fallback', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const failures: number[] = [];
  let error = streamFailure();
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  const send = createBackendFetch(event => failures.push(event.http2Failures), { http2: true });
  const signal = AbortSignal.abort();
  await assert.rejects(send('https://one.test/commands', { signal }));
  await assert.rejects(send(new Request('https://one.test/commands', { signal })));
  error = new TypeError('fetch failed', { cause: Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' }) });
  for (let i = 0; i < 3; i++) await assert.rejects(send('https://one.test/commands'));
  assert.deepEqual(failures, []);
  error = streamFailure();
  await assert.rejects(send('https://one.test/commands'));
  assert.deepEqual(failures, [1]);
});

test('recurring H2 pool failures trigger fallback despite successful heartbeats between them', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const recoveries: Array<{ http2Failures: number; protocol: string }> = [];
  let now = 0, fail = true;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { if (fail) throw streamFailure(); return new Response('{}'); });
  const send = createBackendFetch(event => recoveries.push(event), { http2: true });
  for (let i = 0; i < 3; i++) {
    now = i * 100_000;
    fail = true; await assert.rejects(send('https://one.test/reports'));
    fail = false; await send('https://one.test/heartbeat');
  }
  assert.deepEqual(recoveries.map(event => [event.http2Failures, event.protocol]), [[1, 'http/2'], [2, 'http/2'], [3, 'http/1.1']]);
});

test('the H2 failure window expires old failures instead of penalizing isolated incidents forever', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const failures: number[] = [];
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.method(globalThis, 'fetch', async () => { throw streamFailure(); });
  const send = createBackendFetch(event => failures.push(event.http2Failures), { http2: true });
  for (const timestamp of [0, 100_000, 300_001, 400_001, 400_002]) {
    now = timestamp;
    await assert.rejects(send('https://one.test/reports'));
  }
  assert.deepEqual(failures, [1, 2, 2, 2, 3]);
});

test('HTTP/2 is opt-in: only RELAY_DAEMON_HTTP_PROTOCOL=http2 enables it', async t => {
  const { backendHttp2Enabled, createBackendFetch } = await import('../src/backend-fetch.js');
  assert.equal(backendHttp2Enabled({}), false);
  assert.equal(backendHttp2Enabled({ RELAY_DAEMON_HTTP_PROTOCOL: 'http1' }), false);
  assert.equal(backendHttp2Enabled({ RELAY_DAEMON_HTTP_PROTOCOL: 'auto' }), false);
  assert.equal(backendHttp2Enabled({ RELAY_DAEMON_HTTP_PROTOCOL: ' HTTP2 ' }), true);
  // On HTTP/1.1 there is no pool to recover: failures pass straight to the caller.
  const recoveries: unknown[] = [];
  t.mock.method(globalThis, 'fetch', async () => { throw streamFailure(); });
  const send = createBackendFetch(event => recoveries.push(event), { http2: false });
  for (let i = 0; i < 4; i++) await assert.rejects(send('https://one.test/reports'));
  assert.deepEqual(recoveries, []);
});

test('connection-level HTTP/2 failures count toward fallback; HTTP/1.1 socket loss does not', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const recoveries: Array<{ cause: string; http2Failures: number; protocol: string }> = [];
  const undiciFailure = (code: string, message: string): Error =>
    new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
  let error = undiciFailure('UND_ERR_SOCKET', 'other side closed');
  t.mock.method(globalThis, 'fetch', async () => { throw error; });
  const send = createBackendFetch(event => recoveries.push(event), { http2: true });
  await assert.rejects(send('https://one.test/commands'));
  assert.equal(recoveries.length, 0);
  for (const [code, message] of [
    ['UND_ERR_SOCKET', 'HTTP/2: "GOAWAY" frame received with code 11'],
    ['UND_ERR_INFO', 'HTTP/2: "frameError" received - type 1, code 2'],
    ['UND_ERR_INFO', 'HTTP/2: stream closed before the response was complete'],
  ]) {
    error = undiciFailure(code, message);
    await assert.rejects(send('https://one.test/commands'));
  }
  assert.deepEqual(recoveries.map(event => [event.cause, event.http2Failures, event.protocol]),
    [['reset', 1, 'http/2'], ['reset', 2, 'http/2'], ['reset', 3, 'http/1.1']]);
});

test('a request deadline replaces a stalled HTTP/2 pool without spending the fallback budget', async t => {
  const { createBackendFetch } = await import('../src/backend-fetch.js');
  const recoveries: Array<{ cause: string; http2Failures: number; protocol: string }> = [];
  const dispatchers = new Set<unknown>();
  t.mock.method(globalThis, 'fetch', (_input: unknown, init: RequestInit & { dispatcher?: unknown }) => {
    dispatchers.add(init.dispatcher);
    return new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  });
  const send = createBackendFetch(event => recoveries.push(event), { http2: true });
  for (let i = 0; i < 4; i++) {
    // The daemon combines its runtime signal with a deadline, as requestSignal does.
    // AbortSignal.timeout's timer is unref'd and cannot hold this test open, so
    // a held timer stands in for it with the same TimeoutError reason.
    const deadline = new AbortController();
    const signal = AbortSignal.any([new AbortController().signal, deadline.signal]);
    setTimeout(() => deadline.abort(new DOMException('The operation timed out.', 'TimeoutError')), 5);
    await assert.rejects(send('https://one.test/commands', { signal }), { name: 'TimeoutError' });
  }
  assert.deepEqual(recoveries.map(event => [event.cause, event.http2Failures, event.protocol]),
    Array.from({ length: 4 }, () => ['stall', 0, 'http/2']));
  assert.equal(dispatchers.size, 4);
  // A caller that gives up is not evidence about the connection.
  const controller = new AbortController();
  const cancelled = assert.rejects(send('https://one.test/commands', { signal: controller.signal }));
  controller.abort('Transport recovery probe superseded a stalled poll.');
  await cancelled;
  assert.equal(recoveries.length, 4);
});
