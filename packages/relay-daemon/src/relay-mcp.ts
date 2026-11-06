/** Local stdio/HTTP transport only. Python owns the MCP protocol and tools. */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { forwardMcp, type Forward } from './relay-mcp-http.js';
export { forwardMcp } from './relay-mcp-http.js';
import { managedMcpForwarder, MANAGED_MCP_CONTEXT_ENV } from './relay-mcp-managed.js';
// Limit both HTTP requests and managed bridge subprocesses. Pause stdin at the
// limit so a client cannot turn a batch into an unbounded in-memory queue.
const MAX_IN_FLIGHT = 8;
export async function serveMcp(forward: Forward): Promise<void> {
    let pending = '';
    const inFlight = new Set<Promise<void>>();
    const dispatch = async (message: unknown): Promise<void> => {
        try {
            const result = await forward(message);
            if (result !== undefined)
                process.stdout.write(JSON.stringify(result) + '\n');
        }
        catch {
            const id = (message as { id?: unknown } | null)?.id;
            if (id !== undefined)
                process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Relay MCP unavailable. Check scope, credential health, and backend availability.' } }) + '\n');
        }
    };
    try {
        for await (const chunk of process.stdin) {
            pending += chunk.toString();
            let end: number;
            while ((end = pending.indexOf('\n')) >= 0) {
                const line = pending.slice(0, end);
                pending = pending.slice(end + 1);
                if (Buffer.byteLength(line) > 128 * 1024)
                    throw new Error('MCP frame too large.');
                if (!line.trim())
                    continue;
                let message: unknown;
                try {
                    message = JSON.parse(line);
                }
                catch {
                    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
                    continue;
                }
                // Initialization negotiates headers used by every subsequent call.
                // Keep notifications/initialized ordered; other notifications (such
                // as cancellation) must be able to pass an outstanding tool call.
                const method = (message as { method?: unknown } | null)?.method;
                if (method === 'initialize' || method === 'notifications/initialized') {
                    await Promise.all(inFlight);
                    await dispatch(message);
                } else {
                    const task = dispatch(message);
                    inFlight.add(task);
                    void task.finally(() => inFlight.delete(task));
                    if (inFlight.size >= MAX_IN_FLIGHT)
                        await Promise.race(inFlight);
                }
            }
            if (Buffer.byteLength(pending) > 128 * 1024)
                throw new Error('MCP frame too large.');
        }
    } finally {
        // stdin may close immediately after a batch. Do not exit until all
        // accepted requests have produced their responses.
        await Promise.all(inFlight);
    }
}
export async function runMcp(args: string[]): Promise<void> {
    const path = args[0] === '--config' ? args[1] : undefined;
    if (!path)
        throw new Error('Usage: relay mcp --config <private-config.json>');
    const config = JSON.parse(readFileSync(path, 'utf8')) as {
        backendUrl: string;
        tokenFile: string;
    };
    const managed = process.env[MANAGED_MCP_CONTEXT_ENV]?.trim() || undefined;
    await serveMcp(managed !== undefined ? managedMcpForwarder(config.backendUrl, managed) : forwardMcp(config.backendUrl, config.tokenFile));
}
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runMcp(process.argv.slice(2)).catch(() => { process.stderr.write('Relay MCP could not start. Check its private configuration.\n'); process.exitCode = 1; });
}
