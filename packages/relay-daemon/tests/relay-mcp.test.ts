import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { apiInvoker, handleMcpMessage } from '../src/relay-mcp.js';
import { installRelayMcp } from '../src/relay-mcp-install.js';

test('MCP tools use scoped bearer API and never expose credentials', async () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-mcp-'));
  const token = 'relay_mcp_testsecret'; const tokenFile = join(home, 'token'); writeFileSync(tokenFile, token);
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    assert.equal(request.url, '/api/v1/mcp/projects');
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ projects: [{ id: 'p' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const result = await handleMcpMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'relay_list_projects', arguments: {} } }, apiInvoker(`http://127.0.0.1:${address.port}`, tokenFile));
    assert.match(JSON.stringify(result), /projects/); assert.ok(!JSON.stringify(result).includes(token));
    const denied = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'relay_apply', arguments: {} } }, async () => { throw new Error('must not run'); });
    assert.equal((denied as any).error.code, -32602);
    assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, async () => null), undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test('installation preserves existing runtime settings and comments, is idempotent and refuses collisions', () => {
  const home = mkdtempSync(join(tmpdir(), 'relay-install-'));
  try {
    mkdirSync(join(home, '.codex')); writeFileSync(join(home, '.codex', 'config.toml'), '# personal\nmodel = "test"\n');
    writeFileSync(join(home, '.claude.json'), '{\n// personal\n"theme":"dark", "mcpServers":{"other":{"command":"test"}},\n}\n');
    const options = { home, runtimes: ['codex', 'claude', 'opencode', 'kimi'] as const, configFile: join(home, 'private config.json'), serverName: 'relay-projects-test' };
    const first = installRelayMcp(options); assert.equal(first.length, 4);
    const before = readFileSync(join(home, '.claude.json'), 'utf8'); assert.match(before, /\/\/ personal/); assert.match(before, /other/);
    installRelayMcp(options); assert.equal(readFileSync(join(home, '.claude.json'), 'utf8'), before);
    assert.equal(readFileSync(join(home, '.codex', 'config.toml'), 'utf8').match(/BEGIN RELAY MCP/g)?.length, 1);
    assert.ok(!before.includes('relay_mcp_'));
    writeFileSync(join(home, '.claude.json'), '{"mcpServers":{"relay-projects-test":{"command":"user"}}}');
    assert.throws(() => installRelayMcp({ ...options, runtimes: ['claude'] }), /owned|modified|conflict/i);
    assert.match(readFileSync(join(home, '.claude.json'), 'utf8'), /user/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('real stdio process negotiates, lists tools and invokes the token API', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const home = mkdtempSync(join(tmpdir(), 'relay-mcp-process-'));
  const token = 'relay_mcp_processsecret';
  const tokenFile = join(home, 'mcp.token'); writeFileSync(tokenFile, token, { mode: 0o600 });
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${token}`);
    response.end(JSON.stringify({ projects: [{ id: 'one' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const config = join(home, 'config.json'); writeFileSync(config, JSON.stringify({ backendUrl: `http://127.0.0.1:${(server.address() as any).port}`, tokenFile }));
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/relay-mcp.js', import.meta.url)), '--config', config]);
    let output = ''; let stderr = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
    const messages = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'unknown' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'relay_list_projects' } },
    ];
    child.stdin.end(messages.map(m => JSON.stringify(m)).join('\n') + '\n');
    const code = await new Promise<number | null>((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    assert.equal(code, 0, stderr);
    const replies = output.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(replies.length, 3); assert.equal(replies[0].result.protocolVersion, '2025-11-25');
    assert.ok(replies[1].result.tools.some((t: any) => t.name === 'relay_propose_task_changes'));
    assert.deepEqual(replies[2].result.structuredContent.projects, [{ id: 'one' }]);
    assert.ok(!output.includes(token)); assert.ok(!stderr.includes(token));
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(home, { recursive: true, force: true }); }
});

test('local runtime bootstrap uses its Computer credential once and stores only the MCP token privately', async () => {
  const { bootstrapRelayMcp } = await import('../src/relay-mcp-bootstrap.js');
  const { statSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'relay-mcp-bootstrap-'));
  try {
    let issued = 0;
    const options = { home, stateDir: join(home, 'private'), sandboxId: 'computer', backendUrl: 'https://relay.example', nodeToken: 'node-secret', env: {}, runtimes: ['codex', 'pi'], fetchFn: (async (_url: unknown, request: RequestInit) => {
      assert.equal((request.headers as any).Authorization, 'Bearer node-secret');
      if (JSON.parse(String(request.body)).existingToken) return Response.json({renewed:false});
      issued++; return Response.json({ token: 'relay_mcp_private' });
    }) as typeof fetch };
    await bootstrapRelayMcp(options); await bootstrapRelayMcp(options); assert.equal(issued, 1);
    assert.equal(statSync(join(home, 'private', 'credentials', 'mcp.token')).mode & 0o777, 0o600);
    const config = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.ok(!config.includes('node-secret')); assert.ok(!config.includes('relay_mcp_private'));
    const { pathToFileURL } = await import('node:url');
    const extensions = join(home, '.pi', 'agent', 'extensions');
    const extension = await import(pathToFileURL(join(extensions, readdirSync(extensions)[0]!)).href);
    const events = new Map<string, () => Promise<void>>(); const registered: any[] = [];
    extension.default({on: (name: string, callback: () => Promise<void>) => events.set(name, callback), registerTool: (tool: unknown) => registered.push(tool)});
    try {
      await events.get('session_start')!();
      assert.equal(registered.length, 9);
      const proposal = registered.find(tool => tool.name.startsWith('relay_propose_task_changes'));
      assert.equal(proposal.parameters[Symbol.for('TypeBox.Kind')], 'Object');
      assert.equal(proposal.parameters.properties.operations.items.properties.kind[Symbol.for('TypeBox.Kind')], 'Union');
    } finally { await events.get('session_shutdown')!(); }

  } finally { rmSync(home, { recursive: true, force: true }); }
});
