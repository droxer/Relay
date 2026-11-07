/** Run-scoped native IPC. Backend credentials never enter this transport. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdtempSync, rmdirSync } from 'node:fs';
import { connect, createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface NativeMcpAddress { socketPath: string; secret: string }
type Invoke = (tool: string, args: Record<string, unknown>) => Promise<unknown>;
// Envelopes have a little headroom over the public 128 KiB / 1 MiB frames.
const MAX_REQUEST = 132 * 1024;
const MAX_RESPONSE = 1024 * 1024 + 4096;
const MAX_ACTIVE = 8;

export async function startNativeMcpBridge(invoke: Invoke): Promise<{
  address: NativeMcpAddress; dispose: () => Promise<void>;
}> {
  const secret = randomBytes(32).toString('hex');
  const privateDir = mkdtempSync(join(tmpdir(), 'rmcp-'));
  chmodSync(privateDir, 0o700);
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\relay-mcp-${randomBytes(16).toString('hex')}` : join(privateDir, 's');
  const sockets = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  let closed = false;
  const server = createServer(socket => {
    if (closed || sockets.size >= 32) { socket.destroy(); return; }
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(65000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_REQUEST || closed) { socket.destroy(); return; }
        let request: { id: number; secret: string; tool: string; args: Record<string, unknown> };
        try {
          request = JSON.parse(line);
          if (!request || !Number.isSafeInteger(request.id) || typeof request.secret !== 'string'
            || request.secret.length !== secret.length
            || !timingSafeEqual(Buffer.from(request.secret), Buffer.from(secret))
            || typeof request.tool !== 'string' || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) {
            socket.destroy(); return;
          }
        } catch { socket.destroy(); return; }
        // Refuse overload before invoking anything; never accumulate an
        // unbounded request queue behind slow backend calls or slow readers.
        if (pending.size >= MAX_ACTIVE) { socket.destroy(); return; }
        const task = (async () => {
          let reply: unknown;
          try { reply = { id: request.id, result: await invoke(request.tool, request.args) }; }
          catch { reply = { id: request.id, error: 'Relay MCP request failed; its outcome may be uncertain.' }; }
          let encoded = JSON.stringify(reply) + '\n';
          if (Buffer.byteLength(encoded) > MAX_RESPONSE) encoded = JSON.stringify({ id: request.id, error: 'Tool result too large; narrow the query.' }) + '\n';
          if (!socket.destroyed) await new Promise<void>(resolve => socket.write(encoded, () => resolve()));
        })().catch(() => { socket.destroy(); });
        pending.add(task);
        void task.then(() => pending.delete(task));
      }
      if (Buffer.byteLength(buffer) > MAX_REQUEST) socket.destroy();
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => { server.removeListener('error', reject); resolve(); });
    });
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    rmdirSync(privateDir);
    throw error;
  }
  let disposal: Promise<void> | undefined;
  return {
    address: { socketPath, secret },
    dispose() {
      return disposal ??= (async () => {
        closed = true;
        const stopped = new Promise<void>(resolve => server.close(() => resolve()));
        for (const socket of sockets) socket.destroy();
        await Promise.all(pending);
        await stopped;
        rmdirSync(privateDir);
      })();
    },
  };
}

/** One multiplexed connection per runtime bridge; no request is ever replayed. */
export function nativeMcpForwarder(address: NativeMcpAddress): Invoke {
  let socket: Socket | undefined;
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  const unavailable = () => new Error('Run-scoped Relay MCP unavailable; do not retry writes with an uncertain outcome.');
  const open = (): Socket => {
    const current = connect(address.socketPath);
    current.setEncoding('utf8');
    let buffer = '';
    const fail = () => {
      if (socket !== current) return;
      socket = undefined;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(unavailable()); }
      pending.clear();
      current.destroy();
    };
    current.on('error', fail);
    current.once('close', fail);
    current.on('data', (chunk: string) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_RESPONSE) { fail(); return; }
        try {
          const reply = JSON.parse(line);
          const call = pending.get(reply.id);
          if (!call) { fail(); return; }
          pending.delete(reply.id);
          clearTimeout(call.timer);
          if (reply.error) call.reject(unavailable());
          else call.resolve(reply.result);
        } catch { fail(); return; }
      }
      if (Buffer.byteLength(buffer) > MAX_RESPONSE) { fail(); return; }
      if (!pending.size) current.unref();
    });
    return current;
  };
  return async (tool, args) => {
    if (pending.size >= MAX_ACTIVE) throw new Error('Too many active Relay MCP requests.');
    const id = nextId++;
    const encoded = JSON.stringify({ id, secret: address.secret, tool, args }) + '\n';
    if (Buffer.byteLength(encoded) > MAX_REQUEST) throw new Error('MCP frame too large.');
    socket ??= open();
    const current = socket;
    current.ref();
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => current.destroy(), 65000);
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      current.write(encoded);
    });
  };
}
