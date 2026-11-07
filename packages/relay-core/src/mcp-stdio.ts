/** Shared bounded stdio framing. Self-contained for the VM's inline launcher. */
export async function serveMcpStdio(
  forward: (message: unknown) => Promise<unknown | undefined>,
  failureMessage: string,
): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  let pending = '';
  // Node's streaming decoder retains incomplete UTF-8 characters across chunks.
  process.stdin.setEncoding('utf8');
  const write = (reply: unknown): Promise<void> => new Promise((resolve, reject) => {
    process.stdout.write(JSON.stringify(reply) + '\n', error => error ? reject(error) : resolve());
  });
  const dispatch = async (message: unknown): Promise<void> => {
    let reply: unknown;
    try { reply = await forward(message); }
    catch {
      const id = (message as { id?: unknown } | null)?.id;
      if (id !== undefined) reply = { jsonrpc: '2.0', id, error: { code: -32000, message: failureMessage } };
    }
    if (reply !== undefined) await write(reply);
  };
  try {
    for await (const chunk of process.stdin) {
      pending += chunk;
      let end: number;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        if (Buffer.byteLength(line) > 128 * 1024) throw new Error('MCP frame too large.');
        if (!line.trim()) continue;
        let message: unknown;
        try { message = JSON.parse(line); }
        catch {
          await write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
          continue;
        }
        const method = (message as { method?: unknown } | null)?.method;
        if (method === 'initialize' || method === 'notifications/initialized') {
          await Promise.all(inFlight);
          await dispatch(message);
        } else {
          // Keep the slot until stdout flushes, so a slow client also applies
          // backpressure to HTTP requests and stdin, not an unbounded queue.
          const task = dispatch(message);
          inFlight.add(task);
          void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
          if (inFlight.size >= 8) await Promise.race(inFlight);
        }
      }
      if (Buffer.byteLength(pending) > 128 * 1024) throw new Error('MCP frame too large.');
    }
    if (pending.trim()) throw new Error('Incomplete MCP frame.');
  } finally { await Promise.all(inFlight); }
}
