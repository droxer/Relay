import { serveMcpStdio } from './mcp-stdio.js';
/** A per-run stdio MCP proxy. It writes no credentials or configuration files. */
export interface ConnectionToolAccess { url: string; token: string }

// Self-contained so the same launcher runs on native Computers and inside a VM.
// Only the run credential crosses this boundary; provider tokens stay server-side.
const PROXY = `
(${serveMcpStdio.toString()})(async rpc => {
  const response = await fetch(process.env.RELAY_CONNECTION_URL, {
    method: 'POST', headers: {'Content-Type':'application/json', Authorization:'Bearer ' + process.env.RELAY_CONNECTION_TOKEN},
    body: JSON.stringify(rpc), signal: AbortSignal.timeout(30000), redirect:'error',
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('Connection tools unavailable'); }
  if (rpc?.id === undefined) { await response.body?.cancel(); return; }
  if (!response.body) throw new Error('Connection response unavailable');
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    for (;;) {
      const {done,value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2097152) throw new Error('Connection response too large');
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}, 'Connection tools unavailable; do not retry writes with an uncertain outcome.').catch(() => { process.exitCode = 1; });
`;

export function connectionServer(access: ConnectionToolAccess) {
  const url = new URL(access.url);
  if (!(url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "host.boxlite.internal"].includes(url.hostname)))) {
    throw new Error("Connection tools require a trusted HTTPS backend");
  }
  return { type: "stdio" as const, command: "node", args: ["-e", PROXY],
    env: { RELAY_CONNECTION_URL: access.url, RELAY_CONNECTION_TOKEN: access.token } };
}

export function codexConnectionArgs(access: ConnectionToolAccess | undefined): string[] {
  if (!access) return [];
  const spec = connectionServer(access);
  return Object.entries({ command: spec.command, args: spec.args, "env.RELAY_CONNECTION_URL": spec.env.RELAY_CONNECTION_URL,
    "env.RELAY_CONNECTION_TOKEN": spec.env.RELAY_CONNECTION_TOKEN }).flatMap(([key, value]) =>
    ["-c", `mcp_servers.relay_connections.${key}=${JSON.stringify(value)}`]);
}
