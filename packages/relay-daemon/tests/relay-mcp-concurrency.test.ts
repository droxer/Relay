import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

test('stdio bounds active calls and isolates parse and forwarding errors', async () => {
  const module = new URL('../src/relay-mcp.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { serveMcp } from ${JSON.stringify(module)};
    let active = 0;
    let peak = 0;
    await serveMcp(async message => {
      peak = Math.max(peak, ++active);
      await new Promise(resolve => setTimeout(resolve, 50));
      active--;
      if (message.id === 3) throw new Error('private failure details');
      if (message.id === undefined) return undefined;
      return {jsonrpc:'2.0', id:message.id, result:{peak}};
    });
  `], { timeout: 5000 });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exit = new Promise(resolve => child.on('exit', resolve));
  child.stdin.end('invalid JSON\n' + [
    { jsonrpc: '2.0', method: 'notifications/test' },
    ...Array.from({ length: 20 }, (_, id) => ({ jsonrpc: '2.0', id, method: 'tools/call' })),
  ].map(message => JSON.stringify(message)).join('\n') + '\n');
  assert.equal(await exit, 0);
  const replies = output.trim().split('\n').map(line => JSON.parse(line));
  assert.equal(replies.length, 21);
  assert.equal(replies.find(reply => reply.id === null).error.code, -32700);
  assert.equal(replies.find(reply => reply.id === 3).error.code, -32000);
  assert.equal(Math.max(...replies.filter(reply => reply.result).map(reply => reply.result.peak)), 8);
  assert.doesNotMatch(output, /private failure details/);
  assert.deepEqual(replies.filter(reply => reply.id !== null).map(reply => reply.id).sort((a, b) => a - b), Array.from({ length: 20 }, (_, id) => id));
});

test('stdio overlaps tool calls, preserves initialization order and drains EOF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relay-mcp-concurrent-'));
  const release = Promise.withResolvers<void>();
  const fast = Promise.withResolvers<void>();
  const initialized = Promise.withResolvers<void>();
  let negotiated = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const message = JSON.parse(raw);
    if (message.method === 'initialize') {
      await initialized.promise;
      negotiated = true;
    } else {
      assert.equal(negotiated, true);
      assert.equal(req.headers['mcp-protocol-version'], '2025-11-25');
    }
    if (message.id === 2) await release.promise;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: message.method === 'initialize' ? { protocolVersion: '2025-11-25' } : {} }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = join(root, 'config.json');
  const tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'relay_mcp_concurrency');
  writeFileSync(config, JSON.stringify({ backendUrl: `http://127.0.0.1:${(server.address() as any).port}`, tokenFile }));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/relay-mcp.js', import.meta.url)), '--config', config], { env: { ...process.env, RELAY_MCP_RUN_CONTEXT: '' } });
  let output = '';
  let stderr = '';
  // The server receiving the request is too early: its response may still be
  // in transit. Release the slow call only after the bridge emits the fast reply.
  createInterface({ input: child.stdout }).on('line', line => {
    output += line + '\n';
    if (JSON.parse(line).id === 3) fast.resolve();
  });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = new Promise(resolve => child.on('exit', resolve));
  const timeout = setTimeout(() => fast.reject(new Error(`Fast MCP request blocked by the slow call: ${output} ${stderr}`)), 2000);
  try {
    child.stdin.end([
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call' },
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
    ].map(message => JSON.stringify(message)).join('\n') + '\n');
    initialized.resolve();
    await fast.promise;
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await exit;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(output.trim().split('\n').map(line => JSON.parse(line).id), [1, 3, 2]);
});
