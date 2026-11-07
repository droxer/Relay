import assert from 'node:assert/strict';
import { test } from 'node:test';
import { managedMcpForwarder } from '../src/relay-mcp-managed.js';
const nativeModule = '../src/relay-mcp-native.js';

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
