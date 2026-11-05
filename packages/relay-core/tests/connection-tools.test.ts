import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
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
