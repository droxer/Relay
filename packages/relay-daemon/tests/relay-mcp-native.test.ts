import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connect } from 'node:net';
import { once } from 'node:events';
import { managedMcpForwarder } from '../src/relay-mcp-managed.js';
const nativeModule = '../src/relay-mcp-native.js';

test('a standalone managed run forwards MCP without a Project or standalone credential', async () => {
  const { startNativeMcpBridge } = await import(nativeModule);
  const bridge = await startNativeMcpBridge(async (_tool: string, args: Record<string, unknown>) => args.message);
  try {
    const forward = managedMcpForwarder('https://relay.example', JSON.stringify({
      backendUrl: 'https://relay.example', native: bridge.address,
    }));
    const message = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    assert.deepEqual(await forward(message), message);
  } finally { await bridge.dispose(); }
});

test('native managed MCP reuses authenticated IPC without a subprocess or file mailbox', async () => {
  const { startNativeMcpBridge } = await import(nativeModule);
  let calls = 0;
  const bridge = await startNativeMcpBridge(async (_tool: string, args: Record<string, unknown>) => {
    calls++;
    return args.message;
  });
  const context = { backendUrl: 'https://relay.example', projectId: 'project', native: bridge.address };
  const forward = managedMcpForwarder(context.backendUrl, JSON.stringify(context));
  try {
    for (let id = 0; id < 1009; id++) {
      const request = { jsonrpc: '2.0', id, method: 'ping', text: '中文😀' };
      assert.deepEqual(await forward(request), request);
    }
    assert.equal(calls, 1009);
    const bad = managedMcpForwarder(context.backendUrl, JSON.stringify({ ...context, native: { ...bridge.address, secret: 'wrong' } }));
    await assert.rejects(bad({ jsonrpc: '2.0', id: 1, method: 'ping' }));
    assert.equal(calls, 1009, 'unauthenticated requests never invoke tools');
  } finally { await bridge.dispose(); }
  await assert.rejects(forward({ jsonrpc: '2.0', id: 1, method: 'ping' }));
});

test('native IPC multiplexes calls and reports disconnects without replaying writes', async () => {
  const { startNativeMcpBridge } = await import(nativeModule);
  const release = Promise.withResolvers<void>();
  let calls = 0;
  const bridge = await startNativeMcpBridge(async (_tool: string, args: Record<string, unknown>) => {
    calls++;
    const rpc = args.message as { id: number };
    if (rpc.id === 1) await release.promise;
    return { jsonrpc: '2.0', id: rpc.id, result: {} };
  });
  const forward = managedMcpForwarder('https://relay.example', JSON.stringify({ backendUrl: 'https://relay.example', projectId: 'p', native: bridge.address }));
  const slow = forward({ jsonrpc: '2.0', id: 1, method: 'tools/call' });
  try {
    assert.equal((await forward({ jsonrpc: '2.0', id: 2, method: 'ping' }) as any).id, 2);
    release.resolve();
    assert.equal((await slow as any).id, 1);
  } finally { release.resolve(); await bridge.dispose(); }
  await assert.rejects(forward({ jsonrpc: '2.0', id: 3, method: 'tools/call' }));
  assert.equal(calls, 2);
});

test('native IPC bounds frames and active calls, and disposal rejects unfinished writes once', async () => {
  const { startNativeMcpBridge } = await import(nativeModule);
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let calls = 0;
  const bridge = await startNativeMcpBridge(async (_tool: string, args: Record<string, unknown>) => {
    calls++;
    const rpc = args.message as { method: string };
    if (rpc.method === 'large') return { text: 'x'.repeat(2 * 1024 * 1024) };
    entered.resolve();
    await release.promise;
    return null;
  });
  const forward = managedMcpForwarder('https://relay.example', JSON.stringify({ backendUrl: 'https://relay.example', projectId: 'p', native: bridge.address }));
  try {
    await assert.rejects(forward({ method: 'ping', text: 'x'.repeat(140 * 1024) }), /large/);
    assert.equal(calls, 0);
    await assert.rejects(forward({ method: 'large' }));
    const waiting = Array.from({ length: 8 }, () => forward({ method: 'tools/call' }));
    const failures = waiting.map(call => assert.rejects(call, /uncertain/));
    await entered.promise;
    await assert.rejects(forward({ method: 'tools/call' }), /Too many/);
    const disposal = bridge.dispose();
    await Promise.all(failures);
    release.resolve();
    await disposal;
    assert.ok(calls <= 9, 'requests are never replayed during disconnect');
  } finally { release.resolve(); await bridge.dispose(); }
});

test('native socket rejects malformed, oversized and unauthenticated frames before dispatch', { timeout: 5000 }, async () => {
  const { startNativeMcpBridge } = await import(nativeModule);
  let calls = 0;
  const bridge = await startNativeMcpBridge(async () => { calls++; throw new Error('private-credential-details'); });
  try {
    for (const frame of ['not-json\n', 'x'.repeat(140 * 1024), JSON.stringify({ id: 1, secret: 'wrong', tool: 'mcp', args: {} }) + '\n']) {
      const socket = connect(bridge.address.socketPath);
      socket.on('error', () => {});
      const closed = new Promise<void>(resolve => socket.once('close', () => resolve()));
      await once(socket, 'connect');
      socket.write(frame);
      await closed;
    }
    assert.equal(calls, 0);
    const forward = managedMcpForwarder('https://relay.example', JSON.stringify({ backendUrl: 'https://relay.example', projectId: 'p', native: bridge.address }));
    await assert.rejects(forward({ method: 'tools/call' }), error => {
      assert.doesNotMatch(String(error), /private-credential-details/);
      return true;
    });
    assert.equal(calls, 1);
  } finally { await bridge.dispose(); }
});
