import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import test from "node:test";
import { buildClaudeCommand, buildCodexCommand, initialAgentState } from "../src/index.js";
import { connectionServer } from "../src/connection-tools.js";

test("Codex and Claude receive per-run connection tools without changing user config", () => {
  const state = { ...initialAgentState("Read issues"), connection_tools: { url: "https://relay.example/api/v1/connection-tools", token: "run-only" } };
  const codex = buildCodexCommand(state);
  assert.match(codex, /mcp_servers\.relay_connections/);
  const claude = buildClaudeCommand(state);
  assert.match(claude, /--mcp-config/);
  assert.match(claude, /relay_connections/);
  assert.doesNotMatch(buildCodexCommand(initialAgentState("Read issues")), /relay_connections/);
});

test("stdio proxy forwards JSON-RPC with only the run credential", async () => {
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer run-only");
    let data = "";
    for await (const chunk of req) data += chunk;
    const rpc = JSON.parse(data);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { tools: [] } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const spec = connectionServer({ url: `http://127.0.0.1:${address.port}`, token: "run-only" });
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } });
  try {
    const output = once(child.stdout, "data");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) + "\n");
    const [data] = await output;
    assert.deepEqual(JSON.parse(String(data)).result, { tools: [] });
  } finally {
    child.kill();
    server.close();
  }
});

test('connection proxy overlaps reads, bounds concurrency, orders initialization and drains EOF', { timeout: 6000 }, async () => {
  const release = Promise.withResolvers<void>();
  const fast = Promise.withResolvers<void>();
  let active = 0;
  let peak = 0;
  let initialized = false;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const rpc = JSON.parse(raw);
    peak = Math.max(peak, ++active);
    if (rpc.method === 'initialize') {
      await new Promise(resolve => setTimeout(resolve, 30));
      initialized = true;
    } else assert.equal(initialized, true);
    if (rpc.id === 2) await release.promise;
    else await new Promise(resolve => setTimeout(resolve, 10));
    active--;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: {} }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const spec = connectionServer({ url: `http://127.0.0.1:${address.port}`, token: 'run-only' });
  const child = spawn(spec.command, spec.args, { env: { ...process.env, ...spec.env } });
  const exit = once(child, 'exit');
  const replies: number[] = [];
  createInterface({ input: child.stdout }).on('line', line => {
    const rpc = JSON.parse(line);
    replies.push(rpc.id);
    if (rpc.id === 3) fast.resolve();
  });
  const timeout = setTimeout(() => fast.reject(new Error('fast call blocked by slow provider')), 1500);
  try {
    child.stdin.end(Array.from({ length: 22 }, (_, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1,
      method: i === 0 ? 'initialize' : 'tools/call' })).join('\n') + '\n');
    await fast.promise;
    assert.ok(!replies.includes(2));
  } finally {
    clearTimeout(timeout);
    release.resolve();
    await exit;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  assert.equal(replies.length, 22);
  assert.ok(peak > 1 && peak <= 8, `peak active calls: ${peak}`);
});
