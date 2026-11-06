/** Relay MCP stdio endpoint. Runtime configuration contains a token file path, never a token. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relayApiUrl } from 'relay-core/api-url';

const toolMap: Record<string, string> = {
  relay_project_overview: 'overview', relay_list_tasks: 'tasks', relay_get_task: 'task',
  relay_task_review: 'review', relay_project_activity: 'activity', relay_project_threads: 'threads',
  relay_get_thread: 'thread', relay_propose_task_changes: 'propose',
};
const descriptions: Record<string, string> = {
  overview: 'Read current Project goal, context, roster and Task counts.',
  tasks: 'List Project Tasks with status, query, cursor and limit filters.',
  task: 'Read a Task and its current revision before proposing edits.',
  review: 'Read Task review evidence.', activity: 'Read Project activity within an explicit time window.',
  threads: 'List Project Threads.', thread: 'Read a Project Thread.',
  propose: 'Stage up to 20 Task operations for owner review. Does not apply or start work.',
};
export const relayMcpTools = [
  { name: 'relay_list_projects', description: 'List Projects this token can access.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ...Object.entries(toolMap).map(([name, tool]) => ({ name, description: descriptions[tool], inputSchema: {
    type: 'object', properties: {
      projectId: { type: 'string' }, taskId: { type: 'string' }, threadId: { type: 'string' },
      query: { type: 'string' }, status: { type: 'string' }, since: { type: 'string' }, cutoff: { type: 'string' },
      cursor: { anyOf: [{ type: 'string' }, { type: 'number' }] }, limit: { type: 'integer', minimum: 1, maximum: 100 },
      operations: { type: 'array', maxItems: 20, items: { type: 'object', properties: {
        kind: { enum: ['create', 'update', 'prerequisites'] }, key: { type: 'string' }, taskId: { type: 'string' },
        fields: { type: 'object', properties: { title: { type: 'string' }, description: { type: 'string' }, priority: { enum: ['low', 'normal', 'high'] }, dueDate: { type: ['string', 'null'] }, tags: { type: 'array', items: { type: 'string' } }, assignedAgentId: { type: ['string', 'null'] }, assignedTeamId: { type: ['string', 'null'] } }, additionalProperties: false },
        after: { type: 'array', items: { type: 'string' } }, afterTaskIds: { type: 'array', items: { type: 'string' } },
      }, required: ['kind'], additionalProperties: false } },
    }, required: ['projectId', ...(['task', 'review'].includes(tool) ? ['taskId'] : tool === 'thread' ? ['threadId'] : tool === 'propose' ? ['operations'] : [])], additionalProperties: false,
  } })),
];
type Invoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
export async function handleMcpMessage(message: unknown, invoke: Invoke): Promise<unknown | undefined> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
  const request = message as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  if (request.id === undefined) return undefined;
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: request.id, result });
  const error = (code: number, text: string) => ({ jsonrpc: '2.0', id: request.id, error: { code, message: text } });
  if (request.jsonrpc !== '2.0' || typeof request.method !== 'string') return error(-32600, 'Invalid request');
  if (request.method === 'initialize') return reply({ protocolVersion: ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'].includes(String(request.params?.protocolVersion)) ? request.params!.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'relay-projects', version: '1.0.0' } });
  if (request.method === 'ping') return reply({});
  if (request.method === 'tools/list') return reply({ tools: relayMcpTools });
  if (request.method !== 'tools/call') return error(-32601, 'Method not found');
  const name = request.params?.name;
  const args = request.params?.arguments ?? {};
  if (typeof name !== 'string' || !relayMcpTools.some(t => t.name === name) || !args || typeof args !== 'object' || Array.isArray(args)) return error(-32602, 'Invalid tool or arguments');
  const values = args as Record<string, unknown>;
  if (name !== 'relay_list_projects' && (typeof values.projectId !== 'string' || !values.projectId)) return error(-32602, 'projectId is required');
  try {
    const result = await invoke(name === 'relay_list_projects' ? 'projects' : toolMap[name]!, values);
    return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], ...(result && typeof result === 'object' && !Array.isArray(result) ? { structuredContent: result } : {}) });
  } catch {
    // HTTP details and credential-bearing configuration must never enter protocol output.
    return reply({ isError: true, content: [{ type: 'text', text: 'Relay tool failed. Check token scope, expiry, and Project availability.' }] });
  }
}

export function apiInvoker(backendUrl: string, tokenFile: string): Invoke {
  const url = new URL(backendUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('Relay MCP requires HTTPS or loopback HTTP.');
  return async (tool, args) => {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (!/^relay_mcp_[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid Relay MCP token file.');
    const response = await fetch(relayApiUrl(backendUrl, tool === 'projects' ? '/mcp/projects' : `/mcp/projects/${encodeURIComponent(String(args.projectId))}/tools`), {
      method: tool === 'projects' ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(tool === 'projects' ? {} : { body: JSON.stringify({ tool, arguments: args }) }),
      signal: AbortSignal.timeout(60_000), redirect: 'error',
    });
    if (!response.ok || Number(response.headers.get('content-length') ?? 0) > 1024 * 1024) throw new Error('Relay API request failed.');
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    try { while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 1024 * 1024) throw new Error('Response too large.'); chunks.push(part.value); } }
    finally { await reader.cancel(); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  };
}
export async function serveMcp(invoke: Invoke): Promise<void> {
  let pending = '';
  for await (const chunk of process.stdin) {
    pending += chunk.toString();
    if (Buffer.byteLength(pending) > 128 * 1024) throw new Error('MCP request too large.');
    let end: number;
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end); pending = pending.slice(end + 1);
      if (!line.trim()) continue;
      let message: unknown;
      try { message = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      const result = await handleMcpMessage(message, invoke);
      if (result !== undefined) process.stdout.write(JSON.stringify(result) + '\n');
    }
  }
}
export async function runMcp(args: string[]): Promise<void> {
  const path = args[0] === '--config' ? args[1] : undefined;
  if (!path) throw new Error('Usage: relay mcp --config <private-config.json>');
  const config = JSON.parse(readFileSync(path, 'utf8')) as { backendUrl: string; tokenFile: string };
  await serveMcp(apiInvoker(config.backendUrl, config.tokenFile));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMcp(process.argv.slice(2)).catch(() => { process.stderr.write('Relay MCP could not start. Check its private configuration.\n'); process.exitCode = 1; });
}
