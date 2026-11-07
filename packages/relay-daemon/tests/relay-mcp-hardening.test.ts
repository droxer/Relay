import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { createProjectManagerBridge } from '../src/project-manager.js';

test('stdio preserves UTF-8 characters split between input chunks', async () => {
  const module = new URL('../src/relay-mcp.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {serveMcp} from ${JSON.stringify(module)};
    process.stderr.write('ready');
    await serveMcp(async m => ({jsonrpc:'2.0',id:m.id,result:m.params}));
  `], { timeout: 5000 });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exit = once(child, 'exit');
  await once(child.stderr, 'data');
  const input = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { query: '中文😀' } }) + '\n');
  for (const byte of input) {
    child.stdin.write(Buffer.from([byte]));
    await delay(1);
  }
  child.stdin.end();
  assert.equal((await exit)[0], 0);
  assert.equal(JSON.parse(output).result.query, '中文😀');
});

test('stdio backpressure stops accepting work when the runtime stops reading replies', { timeout: 6000 }, async () => {
  const module = new URL('../src/relay-mcp.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {serveMcp} from ${JSON.stringify(module)};
    process.stderr.write('ready\\n');
    await serveMcp(async m => {
      process.stderr.write('call\\n');
      return {jsonrpc:'2.0',id:m.id,result:'x'.repeat(1024*1024)};
    });
  `], { timeout: 5000 });
  const exit = once(child, 'exit');
  let status = '';
  child.stderr.on('data', chunk => { status += chunk; });
  await once(child.stderr, 'data');
  try {
    child.stdin.end(Array.from({ length: 20 }, (_, id) => JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call' })).join('\n') + '\n');
    await delay(200);
    const calls = status.split('\n').filter(line => line === 'call').length;
    assert.ok(calls > 0 && calls <= 8, `slow stdout must bound accepted calls: ${calls}`);
  } finally {
    child.stdout.resume();
    assert.equal((await exit)[0], 0);
  }
  assert.equal(status.split('\n').filter(line => line === 'call').length, 20);
});

test('file responses become visible only after their complete JSON is written', async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'relay-atomic-response-'));
  const original = fs.writeFileSync;
  // Extend the actual publication window while the helper runs in another process.
  fs.writeFileSync = ((path: fs.PathOrFileDescriptor, data: any, options: any) => {
    if (String(path).endsWith('.response')) {
      const fd = fs.openSync(path as fs.PathLike, 'wx', 0o600);
      try {
        fs.writeSync(fd, '{');
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        fs.writeSync(fd, String(data).slice(1));
      } finally { fs.closeSync(fd); }
    } else original(path, data, options);
  }) as typeof fs.writeFileSync;
  syncBuiltinESMExports();
  const bridge = createProjectManagerBridge(root, async () => ({ value: 'complete' }));
  try {
    const child = spawn(process.execPath, [join(root, bridge.toolPath), 'mcp', '{}'], { timeout: 5000 });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    const [code] = await once(child, 'exit');
    assert.equal(code, 0, 'helper must never observe partially published JSON');
    assert.deepEqual(JSON.parse(output), { value: 'complete' });
  } finally {
    fs.writeFileSync = original;
    syncBuiltinESMExports();
    await bridge.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('file bridge remains available after more than 1000 calls', { timeout: 20000 }, async () => {
  const root = fs.mkdtempSync(join(tmpdir(), 'relay-long-manager-'));
  let calls = 0;
  const bridge = createProjectManagerBridge(root, async () => { calls++; return {}; });
  const dir = dirname(join(root, bridge.toolPath));
  try {
    for (let i = 0; i < 1009; i++) fs.writeFileSync(join(dir, randomUUID() + '.request'), JSON.stringify({ tool: 'mcp', arguments: {} }));
    const deadline = Date.now() + 12000;
    while (calls < 1009 && Date.now() < deadline) await delay(20);
    assert.equal(calls, 1009);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith('.request')).length, 0);
  } finally { await bridge.dispose(); fs.rmSync(root, { recursive: true, force: true }); }
});
